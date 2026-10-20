#!/usr/bin/env bash
# Prints the newest research summary and the newest paper portfolio results.
set -euo pipefail
cd "$(dirname "$0")/../.."
echo "== research (newest 5 runs)"; tail -n 5 data/research/log.txt 2>/dev/null || echo "no runs yet"
ls data/research/candidate-*.md 2>/dev/null && echo "CANDIDATES FOUND: see the files above" || echo "no candidate has passed"
sed -n '3,13p' data/research/latest.md 2>/dev/null || true
latest="$(ls -dt data/paper/live-* 2>/dev/null | head -n 1)"
[ -n "$latest" ] && [ -f "$latest/summary.json" ] || { echo "no paper run yet"; exit 0; }
echo "== paper run $latest"
node -e '
const s = require(process.argv[1]);
for (const p of s.traders) console.log(`${p.name.padEnd(24)} ${p.equitySol.toFixed(4)} SOL ${p.returnPct.toFixed(2).padStart(7)}% trades=${p.closedTrades} wins=${p.wins} halted=${p.halted}`);
' "$PWD/$latest/summary.json"
