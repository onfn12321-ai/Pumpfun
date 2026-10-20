#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 22.04 or 24.04 server, run as root:
#   curl -fsSL https://raw.githubusercontent.com/onfn12321-ai/Pumpfun/<branch>/deploy/vps/setup.sh | sudo bash -s -- <branch>
# It installs Node.js 20 and Python 3, clones the repository to /opt/pumpfun, and starts
# three paper-only services: pumpfun-record, pumpfun-paper, and pumpfun-research.
# No service holds a wallet key or can send a transaction.
set -euo pipefail
BRANCH="${1:-main}"
REPO="${REPO:-https://github.com/onfn12321-ai/Pumpfun.git}"
DIR=/opt/pumpfun
apt-get update -y
apt-get install -y ca-certificates curl git python3
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
id pumpfun >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin pumpfun
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch origin "$BRANCH" && git -C "$DIR" checkout -B "$BRANCH" "origin/$BRANCH"; else git clone --branch "$BRANCH" "$REPO" "$DIR"; fi
chown -R pumpfun:pumpfun "$DIR"
sudo -u pumpfun bash -c "cd $DIR && npm ci --no-audit --no-fund"
# Optional: put SOLANA_RPC_PROVIDER_KEY=<https RPC URL> in this file for a dedicated RPC.
touch /etc/pumpfun.env && chmod 600 /etc/pumpfun.env
for role in record paper research; do
  cat > "/etc/systemd/system/pumpfun-$role.service" <<UNIT
[Unit]
Description=Pump.fun paper-only $role
After=network-online.target
Wants=network-online.target

[Service]
User=pumpfun
WorkingDirectory=$DIR
EnvironmentFile=/etc/pumpfun.env
ExecStart=$DIR/deploy/vps/run.sh $role
Restart=always
RestartSec=10
Nice=$([ "$role" = research ] && echo 10 || echo 0)

[Install]
WantedBy=multi-user.target
UNIT
done
systemctl daemon-reload
systemctl enable --now pumpfun-record pumpfun-paper pumpfun-research
echo "Started. Check results with: sudo -u pumpfun $DIR/deploy/vps/status.sh"
