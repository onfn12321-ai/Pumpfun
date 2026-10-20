"""Wallet profitability, persistence, and copy-trade simulation on recorded Pump.fun trades."""
import json, bisect, statistics as st, sys
from collections import defaultdict
K = 30 * 1_073_000_000; FEE = 0.0125; SIZE = 0.025; TXFEE = 0.000205; LATSLIP = 0.005
# Usage: python3 analysis/wallet_copy.py data/recordings/*.ndjson
files = sys.argv[1:]
tokens = {}
for fi, f in enumerate(files):
    for line in open(f):
        try: m = json.loads(line)
        except: continue
        d = m["data"]; t = m["observedAt"] / 1000; mint = d.get("mint")
        if d.get("txType") == "create" and d.get("pool", "pump") == "pump" and not d.get("isMayhemMode"):
            if mint not in tokens: tokens[mint] = dict(created=t, creator=d.get("traderPublicKey"), tr=[], bad=False, done=None)
        elif mint in tokens:
            tk = tokens[mint]
            if d.get("txType") == "complete": tk["done"] = tk["done"] or t; continue
            if d.get("txType") not in ("buy", "sell"): continue
            vs, vt = d["vSolInBondingCurve"], d["vTokensInBondingCurve"]
            if abs(vs * vt / K - 1) > 1e-4: tk["bad"] = True; continue
            tk["tr"].append((t, d["txType"] == "buy", d["solAmount"], d["tokenAmount"], d["traderPublicKey"], vs, vt))
good = {k: v for k, v in tokens.items() if not v["bad"] and v["tr"]}
for tk in good.values():
    tk["tr"].sort(key=lambda r: r[0]); tk["times"] = [r[0] for r in tk["tr"]]
allt = sorted(r[0] for tk in good.values() for r in tk["tr"])
t0, t1 = allt[0], allt[-1]; split = allt[int(len(allt) * 0.55)]
print(f"tokens {len(good)} trades {len(allt)} span {(t1-t0)/3600:.2f}h, split at {(split-t0)/3600:.2f}h", file=sys.stderr)

def sell_value(vs, vt, tok):
    return (vs - vs * vt / (vt + tok)) * (1 - FEE) if tok > 0 else 0.0
def wallet_pnl(lo, hi):
    """Per wallet: realized + marked-to-market PnL of positions opened in [lo, hi), marked at hi (or last trade)."""
    pos = defaultdict(lambda: [0.0, 0.0, 0])  # (wallet, mint) -> spent, received, buys
    held = defaultdict(float)
    for mint, tk in good.items():
        for r in tk["tr"]:
            if r[0] >= hi: break
            key = (r[4], mint)
            if r[1]:
                if r[0] < lo: continue
                pos[key][0] += r[2] * (1 + FEE); pos[key][2] += 1; held[key] += r[3]
            elif key in pos:
                sold = min(r[3], held[key]); frac = sold / r[3] if r[3] else 0
                pos[key][1] += r[2] * (1 - FEE) * frac; held[key] -= sold
    w = defaultdict(lambda: dict(pnl=0.0, spent=0.0, n=0, wins=0))
    for (wal, mint), (sp, rc, nb) in pos.items():
        tk = good[mint]; i = bisect.bisect_left(tk["times"], hi) - 1
        vs, vt = tk["tr"][i][5], tk["tr"][i][6]
        mtm = rc + sell_value(vs, vt, held[(wal, mint)]) if not (tk["done"] and tk["done"] < hi) else rc + held[(wal, mint)] * vs / vt
        p = mtm - sp; x = w[wal]; x["pnl"] += p; x["spent"] += sp; x["n"] += 1; x["wins"] += p > 0
    return w
A = wallet_pnl(t0, split); B = wallet_pnl(split, t1 + 1)
print("wallets active train", len(A), "test", len(B))
# Persistence: do train winners stay winners?
both = [k for k in A if k in B and A[k]["n"] >= 3 and B[k]["n"] >= 3]
print("wallets with >=3 tokens in both halves:", len(both))
if both:
    import math
    def rank(v): s = sorted(range(len(v)), key=lambda i: v[i]); r = [0]*len(v); [r.__setitem__(i, j) for j, i in enumerate(s)]; return r
    a = rank([A[k]["pnl"] / A[k]["spent"] for k in both]); b = rank([B[k]["pnl"] / B[k]["spent"] for k in both])
    n = len(both); rho = 1 - 6 * sum((x - y) ** 2 for x, y in zip(a, b)) / (n * (n * n - 1))
    print(f"Spearman rank correlation of ROI train vs test: {rho:+.3f}")
    top = sorted(both, key=lambda k: -A[k]["pnl"])[:max(10, n // 10)]
    print(f"top {len(top)} train wallets by PnL: test ROI mean {st.mean(B[k]['pnl']/B[k]['spent'] for k in top)*100:+.1f}%, profitable in test {sum(B[k]['pnl']>0 for k in top)}/{len(top)}")
    print(f"all {n}: test ROI mean {st.mean(B[k]['pnl']/B[k]['spent'] for k in both)*100:+.1f}%, profitable {sum(B[k]['pnl']>0 for k in both)}/{n}")

# Copy simulation in the test half.
def state_at(tk, t):
    i = bisect.bisect_right(tk["times"], t) - 1
    return (30.0, 1_073_000_000.0) if i < 0 else (tk["tr"][i][5], tk["tr"][i][6])
def copy_sim(selected, lat, exit_mode, lo, hi, maxage=None):
    res = []
    for mint, tk in good.items():
        seen = set()
        for r in tk["tr"]:
            if r[0] < lo or r[0] >= hi or not r[1] or r[4] not in selected or r[4] in seen: continue
            if maxage is not None and r[0] - tk["created"] > maxage: continue
            seen.add(r[4]); te = r[0] + lat
            if tk["done"] and tk["done"] <= te: continue
            vs, vt = state_at(tk, te); e = SIZE * (1 - FEE); tok = (vt - vs * vt / (vs + e)) * (1 - LATSLIP)
            cost = SIZE + TXFEE
            def val(t):
                xs, xt = state_at(tk, t); return ((xs - xs * xt / (xt + tok)) * (1 - FEE) * (1 - LATSLIP) - TXFEE) / cost - 1
            exit_t = te + 600
            if exit_mode == "follow":
                for q in tk["tr"]:
                    if q[0] > r[0] and q[4] == r[4] and not q[1]: exit_t = min(exit_t, q[0] + lat); break
                res.append(val(exit_t)); continue
            tp, sl = exit_mode
            j0 = bisect.bisect_right(tk["times"], te); out = None
            for q in tk["tr"][j0:]:
                if q[0] > te + 600: break
                v = val(q[0] + lat)
                if (((q[5] - q[5] * q[6] / (q[6] + tok)) * (1 - FEE) * (1 - LATSLIP) - TXFEE) / cost - 1) >= tp or v <= -sl: out = v; break
            res.append(out if out is not None else val(te + 600))
    return res
def report(label, sel, lo, hi, maxage=None):
    for lat in (0.4, 1.5):
        for em in ("follow", (0.5, 0.2), (0.25, 0.15)):
            v = copy_sim(sel, lat, em, lo, hi, maxage)
            if v: print(f"{label:38s} lat {lat}s exit {str(em):12s} n={len(v):4d} mean {st.mean(v)*100:+6.2f}% median {st.median(v)*100:+6.2f}% win {sum(x>0 for x in v)/len(v):.0%}")
for minN, crit in ((3, "pnl>0"), (5, "roi>.2"), (5, "winrate>.6")):
    sel = set()
    for k, x in A.items():
        if x["n"] < minN or x["pnl"] <= 0: continue
        if crit == "roi>.2" and x["pnl"] / x["spent"] <= 0.2: continue
        if crit == "winrate>.6" and x["wins"] / x["n"] <= 0.6: continue
        sel.add(k)
    print(f"--- selected {len(sel)} wallets (train n>={minN}, {crit})")
    report(f"in-sample copy (train half)", sel, t0, split)
    report(f"OUT-OF-SAMPLE copy (test half)", sel, split, t1 + 1)
