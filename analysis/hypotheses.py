"""Event-driven strategy research on recorded Pump.fun trades.

Usage: python3 analysis/hypotheses.py OUT_DIR FILE.ndjson [FILE.ndjson ...]

Each hypothesis is a trigger evaluated after an observed trade. An entry fills
LATENCY seconds later at the curve state visible then, with fees, latency
slippage, and network fees. Exits react to later trades with the same latency.

Validation is strict, because the search tests many rule sets:
- The data is split into 3 chronological folds by trade time.
- A candidate passes only if every fold has at least MIN_FOLD trades and a
  positive mean, the bootstrap 5th percentile of the mean is positive, and the
  mean stays positive without the 3 best trades.
Trades that the recording ends before closing are dropped (censored).
"""
import bisect, csv, heapq, itertools, json, os, random, statistics as st, sys, time
from collections import defaultdict

K = 30 * 1_073_000_000
FEE = 0.0125; SIZE = 0.025; TXFEE = 0.000205; LATSLIP = 0.005; LATENCY = 1.5
MIN_FOLD = 15; MIN_TOTAL = 60


def load(files):
    tokens, seen = {}, set()
    for fi, path in enumerate(files):
        end = 0.0
        for line in open(path):
            try:
                m = json.loads(line)
            except ValueError:
                continue
            d = m["data"]; t = m["observedAt"] / 1000; end = max(end, t); mint = d.get("mint"); kind = d.get("txType")
            key = (d.get("signature"), kind, mint, d.get("traderPublicKey"), d.get("solAmount"), d.get("tokenAmount"))
            if key[0] and key in seen:
                continue
            seen.add(key)
            if kind == "create":
                if d.get("pool", "pump") == "pump" and not d.get("isMayhemMode") and mint not in tokens:
                    tokens[mint] = dict(created=t, slot0=d.get("slot"), creator=d.get("traderPublicKey"), tr=[], bad=False, done=None, file=fi)
            elif mint in tokens:
                tk = tokens[mint]
                if kind == "complete":
                    tk["done"] = tk["done"] or t
                elif kind in ("buy", "sell"):
                    vs, vt = d["vSolInBondingCurve"], d["vTokensInBondingCurve"]
                    if abs(vs * vt / K - 1) > 1e-4:
                        tk["bad"] = True
                        continue
                    tk["tr"].append((t, kind == "buy", d["solAmount"], d["tokenAmount"], d["traderPublicKey"], vs, vt, d.get("slot")))
        for tk in tokens.values():
            if tk["file"] == fi:
                tk["end"] = end
    good = {}
    for mint, tk in tokens.items():
        if tk["bad"] or not tk["tr"]:
            continue
        tk["tr"].sort(key=lambda r: r[0])
        tk["times"] = [r[0] for r in tk["tr"]]
        if tk["done"] is None and tk["tr"][-1][5] - 30 >= 84:
            tk["done"] = tk["tr"][-1][0]
        good[mint] = tk
    return good


def features(tk):
    """One feature dict per trade, using that trade and earlier trades only."""
    tr, times = tk["tr"], tk["times"]
    out = []; bal = defaultdict(float); seen_wallets = set(); peak = 0.0; creator_sold = False; first_big_sell = None
    slot0 = tk["slot0"]; bundle = sum(1 for r in tr if r[1] and r[7] is not None and r[7] == slot0 and r[4] != tk["creator"])
    for i, r in enumerate(tr):
        t = r[0]; p = r[5] / r[6]; prev_p = tr[i - 1][5] / tr[i - 1][6] if i else 30 / 1_073_000_000
        peak = max(peak, p)
        bal[r[4]] += r[3] if r[1] else -r[3]
        if r[4] == tk["creator"] and not r[1]:
            creator_sold = True
        first_trade = r[4] not in seen_wallets; seen_wallets.add(r[4])
        if not r[1] and r[2] >= 1.0 and first_big_sell is None:
            first_big_sell = (i, t, r[2])

        def win(sec):
            return tr[bisect.bisect_left(times, t - sec): i + 1]

        w30, w60, w120 = win(30), win(60), win(120)
        j = bisect.bisect_left(times, t - 60) - 1
        p60 = tr[j][5] / tr[j][6] if j >= 0 else 30 / 1_073_000_000
        holders = [x for x in bal.values() if x > 1]
        out.append(dict(
            i=i, t=t, age=t - tk["created"], realsol=r[5] - 30, buy=r[1], sol=r[2], first_trade=first_trade,
            step=p / prev_p - 1, dd=p / peak - 1, peak_realsol=None, r60=p / p60 - 1,
            ub30=len({x[4] for x in w30 if x[1]}), ub60=len({x[4] for x in w60 if x[1]}), ub120=len({x[4] for x in w120 if x[1]}),
            nb60=sum(1 for x in w60 if x[1]), ns60=sum(1 for x in w60 if not x[1]),
            net30=sum(x[2] if x[1] else -x[2] for x in w30), net60=sum(x[2] if x[1] else -x[2] for x in w60),
            maxbuy60=max([x[2] for x in w60 if x[1]], default=0.0), creator_sold=creator_sold,
            holders=len(holders), top10=sum(heapq.nlargest(10, holders)) / 1e9 if holders else 0.0,
            bundle=bundle, first_big_sell=first_big_sell,
        ))
    pk = 0.0
    for f in out:
        pk = max(pk, f["realsol"]); f["peak_realsol"] = pk
    return out


def state_at(tk, t):
    i = bisect.bisect_right(tk["times"], t) - 1
    return (30.0, 1_073_000_000.0) if i < 0 else (tk["tr"][i][5], tk["tr"][i][6])


def simulate(tk, t_signal, exit_rule, migration_penalty):
    """Net return of a 0.025 SOL position, or None when the recording ends first."""
    tp, sl, hold, flow_exit = exit_rule
    tr, times, done = tk["tr"], tk["times"], tk["done"]
    te = t_signal + LATENCY
    if done and done <= te:
        return None
    vs, vt = state_at(tk, te)
    tokens = (vt - vs * vt / (vs + SIZE * (1 - FEE))) * (1 - LATSLIP)
    cost = SIZE + TXFEE

    def net(xs, xt, penalty=0.0):
        return ((xs - xs * xt / (xt + tokens)) * (1 - FEE) * (1 - LATSLIP) * (1 - penalty) - TXFEE) / cost - 1

    def value(t):
        # After graduation the position is valued at the final curve price less a migration penalty.
        if done and t >= done:
            return net(*state_at(tk, done), migration_penalty)
        return net(*state_at(tk, t))

    limit = te + hold
    if done and done < limit:
        limit = done
    for j in range(bisect.bisect_right(times, te), len(tr)):
        q = tr[j]
        if q[0] > limit:
            break
        hit = (tp and net(q[5], q[6]) >= tp) or (sl and net(q[5], q[6]) <= -sl)
        if flow_exit and not hit and q[0] - te >= 10:
            w = tr[bisect.bisect_left(times, q[0] - 20): j + 1]
            hit = sum(1 for x in w if not x[1]) >= 3 and sum(x[2] if x[1] else -x[2] for x in w) < 0
        if hit:
            return value(q[0] + LATENCY)
    if not (done and done <= te + hold) and te + hold > tk["end"]:
        return None
    return value(limit)


def build_hypotheses():
    H = {}
    for d, rng, u in itertools.product((0.08, 0.15, 0.25), ((8, 30), (30, 60), (60, 84)), (5, 15)):
        H[f"dip d{d} sol{rng} ub120>={u}"] = lambda f, d=d, rng=rng, u=u: (not f["buy"] and f["step"] <= -d and rng[0] <= f["realsol"] < rng[1]
                                                                          and f["ub120"] >= u and not f["creator_sold"] and f["age"] >= 60)
    for w, rng in itertools.product((1, 2, 4), ((0, 20), (20, 50), (50, 84))):
        H[f"whale first-buy>={w} sol{rng}"] = lambda f, w=w, rng=rng: (f["buy"] and f["first_trade"] and f["sol"] >= w and f["age"] >= 30
                                                                       and rng[0] <= f["realsol"] < rng[1])
    for x, b in itertools.product((0.4, 0.6), (5, 10)):
        H[f"recover dd<=-{x} ub30>={b} net30>0"] = lambda f, x=x, b=b: (f["dd"] <= -x and f["ub30"] >= b and f["net30"] > 0 and f["peak_realsol"] >= 15)
    for lvl, fl in itertools.product((60, 70, 78), (0, 2)):
        H[f"graduation realsol>={lvl} net60>{fl}"] = lambda f, lvl=lvl, fl=fl: f["realsol"] >= lvl and f["net60"] > fl
    for n, rng in itertools.product((8, 15), ((5, 30), (30, 70))):
        H[f"quiet-accum nb60>={n} ns60=0 sol{rng}"] = lambda f, n=n, rng=rng: (f["nb60"] >= n and f["ns60"] == 0 and f["maxbuy60"] <= 0.5
                                                                            and 0 <= f["r60"] < 0.15 and rng[0] <= f["realsol"] < rng[1])
    for a, k, bund in itertools.product((20, 45), (5, 10), ("clean", "bundled")):
        H[f"launch age>={a} ub60>={k} {bund}"] = lambda f, a=a, k=k, bund=bund: (a <= f["age"] < a + 15 and f["ub60"] >= k and not f["creator_sold"]
                                                                                and ((f["bundle"] <= 1) if bund == "clean" else (f["bundle"] >= 3)))
    for s in (1.0, 2.0):
        H[f"absorb first-sell>={s} rebought"] = lambda f, s=s: (f["first_big_sell"] is not None and f["first_big_sell"][2] >= s
                                                                 and 3 <= f["t"] - f["first_big_sell"][1] <= 20 and f["net30"] > 0 and f["ub30"] >= 3)
    for hmin, top in itertools.product((40, 80), (0.25, 0.4)):
        H[f"breadth holders>={hmin} top10<{top}"] = lambda f, hmin=hmin, top=top: f["holders"] >= hmin and f["top10"] < top and f["realsol"] < 70
    return H


EXITS = {
    "time60": (None, None, 60, False), "time300": (None, None, 300, False),
    "tp15/sl10/180s": (0.15, 0.10, 180, False), "tp30/sl15/300s": (0.30, 0.15, 300, False),
    "tp50/sl20/600s": (0.50, 0.20, 600, False), "tp100/sl30/900s": (1.0, 0.30, 900, False),
    "flow-exit/sl20/600s": (None, 0.20, 600, True),
}


def bootstrap_p5(values, rounds=500):
    rng = random.Random(7); n = len(values)
    means = sorted(sum(values[rng.randrange(n)] for _ in range(n)) / n for _ in range(rounds))
    return means[int(rounds * 0.05)]


def main():
    out_dir, files = sys.argv[1], sys.argv[2:]
    os.makedirs(out_dir, exist_ok=True)
    started = time.time()
    tokens = load(files)
    all_times = sorted(r[0] for tk in tokens.values() for r in tk["tr"])
    bounds = [all_times[len(all_times) // 3], all_times[2 * len(all_times) // 3]]
    feats = {m: features(tk) for m, tk in tokens.items()}
    H = build_hypotheses()
    results = []
    for name, cond in H.items():
        triggers = []
        for mint, fs in feats.items():
            last = -1e18
            for f in fs:
                if f["t"] - last >= 300 and cond(f):
                    triggers.append((mint, f["t"])); last = f["t"]
        for exit_name, rule in EXITS.items():
            for pen in ((0.03, 0.15) if name.startswith("graduation") else (0.03,)):
                rets = []
                for mint, t in triggers:
                    v = simulate(tokens[mint], t, rule, pen)
                    if v is not None:
                        rets.append((t, v))
                if len(rets) < MIN_TOTAL:
                    continue
                vals = [v for _, v in rets]
                folds = [[v for t, v in rets if t < bounds[0]], [v for t, v in rets if bounds[0] <= t < bounds[1]], [v for t, v in rets if t >= bounds[1]]]
                fold_means = [st.mean(x) if x else float("nan") for x in folds]
                trimmed = sorted(vals)[:-3]
                p5 = bootstrap_p5(vals)
                passed = (all(len(x) >= MIN_FOLD for x in folds) and all(m > 0 for m in fold_means) and p5 > 0 and st.mean(trimmed) > 0)
                results.append(dict(hypothesis=name, exit=exit_name, migration_penalty=pen, n=len(vals), mean=st.mean(vals), median=st.median(vals),
                                    win=sum(v > 0 for v in vals) / len(vals), p5=p5, trimmed_mean=st.mean(trimmed),
                                    fold_n="/".join(str(len(x)) for x in folds), fold_means="/".join(f"{m*100:+.1f}" for m in fold_means),
                                    min_fold=min(fold_means), passed=passed))
    results.sort(key=lambda r: -r["min_fold"])
    with open(os.path.join(out_dir, "results.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(results[0].keys()) if results else ["hypothesis"]); w.writeheader(); w.writerows(results)
    # Covered hours: the sum of gaps between consecutive trades that are shorter than 5 minutes.
    # Recording outages are not counted.
    span = sum(b - a for a, b in zip(all_times, all_times[1:]) if b - a < 300) / 3600
    lines = [f"# Hypothesis search", "", f"- Data: {len(tokens)} standard tokens, {len(all_times)} trades, {span:.2f} h of recorded data, {len(files)} files.",
             f"- Tested: {len(H)} triggers x {len(EXITS)} exits = {len(results)} combinations with at least {MIN_TOTAL} trades.",
             f"- Passed all checks: {sum(r['passed'] for r in results)}.", f"- Runtime: {time.time() - started:.0f} s.", "",
             "| Pass | Hypothesis | Exit | n | Mean | Median | Win | Boot p5 | Fold means % |", "|---|---|---|---|---|---|---|---|---|"]
    for r in results[:25]:
        lines.append(f"| {'YES' if r['passed'] else 'no'} | {r['hypothesis']} | {r['exit']} (mig {r['migration_penalty']}) | {r['n']} | {r['mean']*100:+.1f}% | "
                     f"{r['median']*100:+.1f}% | {r['win']:.0%} | {r['p5']*100:+.1f}% | {r['fold_means']} |")
    open(os.path.join(out_dir, "summary.md"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
