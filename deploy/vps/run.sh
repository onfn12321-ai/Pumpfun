#!/usr/bin/env bash
# Runs one long-lived paper-only role forever. systemd restarts it if it stops.
# Usage: deploy/vps/run.sh record|paper|research
# No role in this script can sign or send a transaction.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p data/recordings data/paper data/research
case "${1:-}" in
  record)
    # One file per 6 hours, so the search can use the newest files only.
    # Recordings use about 1.2 GB per day. Old files are deleted after KEEP_DAYS days.
    while :; do
      find data/recordings -name 'rec-*.ndjson' -mtime +"${KEEP_DAYS:-14}" -delete
      # The paper runner keeps its own copy of the market data; the recorder files are enough.
      find data/paper -name market.ndjson -mtime +1 -delete
      RECORD_PATH="data/recordings/rec-$(date -u +%Y%m%dT%H%M%SZ).ndjson" DURATION_MINUTES=360 npm run --silent paper:record
    done
    ;;
  paper)
    # One 24-hour live paper run per day with a fresh 0.5 SOL paper wallet per portfolio.
    while :; do
      run="live-$(date -u +%Y%m%dT%H%M%SZ)"
      RUN_ID="$run" OUTPUT_DIR="data/paper/$run" DURATION_MINUTES=1440 STARTING_BALANCE_SOL="${STARTING_BALANCE_SOL:-0.5}" npm run --silent paper:live
    done
    ;;
  research)
    INTERVAL_SECONDS="${INTERVAL_SECONDS:-3600}" END_EPOCH=0 exec analysis/research_loop.sh
    ;;
  *)
    echo "usage: $0 record|paper|research" >&2
    exit 64
    ;;
esac
