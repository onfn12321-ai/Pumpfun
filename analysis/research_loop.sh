#!/usr/bin/env bash
# Re-runs the hypothesis search every INTERVAL_SECONDS on all recordings until END_EPOCH.
# Exits early when a candidate passes every check on at least MIN_HOURS of data.
set -u
INTERVAL_SECONDS="${INTERVAL_SECONDS:-7200}"
END_EPOCH="${END_EPOCH:?set END_EPOCH}"
MIN_HOURS="${MIN_HOURS:-6}"
mkdir -p data/research
while :; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  files=(data/recordings/live05-full.ndjson data/recordings/live05-v3.ndjson data/recordings/live05-v4-latest.ndjson data/recordings/long-24h.ndjson)
  [ -f data/paper/live-05sol-v4/market.ndjson ] && files+=(data/paper/live-05sol-v4/market.ndjson)
  python3 analysis/hypotheses.py "data/research/$stamp" "${files[@]}" > /dev/null 2>&1
  cp "data/research/$stamp/summary.md" data/research/latest.md
  span="$(grep -o '[0-9.]* h span' data/research/latest.md | cut -d' ' -f1)"
  passed="$(grep -o 'Passed all checks: [0-9]*' data/research/latest.md | grep -o '[0-9]*$')"
  echo "$stamp span=${span}h passed=$passed" | tee -a data/research/log.txt
  if [ "${passed:-0}" -gt 0 ] && awk "BEGIN{exit !($span >= $MIN_HOURS)}"; then
    echo "CANDIDATE FOUND"; grep '^| YES' data/research/latest.md; exit 0
  fi
  [ "$(date +%s)" -ge "$END_EPOCH" ] && { echo "search finished without a passing candidate"; exit 0; }
  sleep "$INTERVAL_SECONDS"
done
