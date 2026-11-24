#!/usr/bin/env bash
# Installs Pi Dashboard as a systemd service that starts on boot.
#   sudo ./install.sh            # port 8080
#   sudo PORT=9000 ./install.sh  # custom port
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo:  sudo ./install.sh" >&2
  exit 1
fi

PORT="${PORT:-8080}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="/opt/pi-dashboard"
RUN_USER="${SUDO_USER:-pi}"

echo "Installing to $DEST_DIR (user: $RUN_USER, port: $PORT)"
mkdir -p "$DEST_DIR"
cp -r "$SRC_DIR/server.py" "$SRC_DIR/static" "$DEST_DIR/"
chmod +x "$DEST_DIR/server.py"

# vcgencmd (throttling/voltage) needs the 'video' group on Raspberry Pi OS
if getent group video >/dev/null; then
  usermod -aG video "$RUN_USER" || true
fi

cat > /etc/systemd/system/pi-dashboard.service <<EOF
[Unit]
Description=Raspberry Pi System Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
SupplementaryGroups=video
ExecStart=/usr/bin/python3 $DEST_DIR/server.py --port $PORT
Restart=on-failure
RestartSec=3
Nice=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pi-dashboard.service
# restart (not just start) so a re-run picks up a new port or updated files
systemctl restart pi-dashboard.service

IP="$(hostname -I | awk '{print $1}')"
echo
echo "Done! Open http://${IP:-<pi-ip>}:$PORT"
echo "Logs:      journalctl -u pi-dashboard -f"
echo "Uninstall: sudo systemctl disable --now pi-dashboard && sudo rm -rf $DEST_DIR /etc/systemd/system/pi-dashboard.service"
