#!/usr/bin/env bash
# Re-runs the hypothesis search every INTERVAL_SECONDS on the newest MAX_FILES recordings.
# When a candidate passes every check on at least MIN_HOURS of data, it copies the
# summary to data/research/candidate-<stamp>.md and keeps searching.
set -u
INTERVAL_SECONDS="${INTERVAL_SECONDS:-7200}"
# END_EPOCH=0 runs until stopped.
END_EPOCH="${END_EPOCH:-0}"
MIN_HOURS="${MIN_HOURS:-6}"
# Each 6-hour recording needs about 1.5 GB of memory in the search. Raise this only with enough RAM.
MAX_FILES="${MAX_FILES:-8}"
mkdir -p data/research
while :; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  # All recordings except two files that are known subsets of other files.
  files=()
  for file in $(ls -t data/recordings/*.ndjson | head -n "$((MAX_FILES + 2))"); do
    case "$file" in *live05-part1.ndjson|*live05-v4.ndjson) continue ;; esac
    [ "${#files[@]}" -lt "$MAX_FILES" ] && files+=("$file")
  done
  python3 analysis/hypotheses.py "data/research/$stamp" "${files[@]}" > /dev/null 2>&1
  cp "data/research/$stamp/summary.md" data/research/latest.md
  span="$(grep -o '[0-9.]* h of recorded data' data/research/latest.md | cut -d' ' -f1)"
  passed="$(grep -o 'Passed all checks: [0-9]*' data/research/latest.md | grep -o '[0-9]*$')"
  echo "$stamp span=${span}h passed=$passed" | tee -a data/research/log.txt
  if [ "${passed:-0}" -gt 0 ] && awk "BEGIN{exit !($span >= $MIN_HOURS)}"; then
    echo "CANDIDATE FOUND"; grep '^| YES' data/research/latest.md
    cp data/research/latest.md "data/research/candidate-$stamp.md"
  fi
  [ "$END_EPOCH" -gt 0 ] && [ "$(date +%s)" -ge "$END_EPOCH" ] && { echo "search finished"; exit 0; }
  sleep "$INTERVAL_SECONDS"
done
