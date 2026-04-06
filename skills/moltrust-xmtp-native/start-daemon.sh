#!/bin/sh
# Auto-restarting XMTP daemon wrapper
# Usage: nohup ./start-daemon.sh >> /path/to/daemon.log 2>&1 &

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${XMTP_DATA_DIR:-/home/node/.openclaw/xmtp-data}"

echo "[watchdog] Starting at $(date)"

while true; do
  cd "$SCRIPT_DIR"
  node22 daemon.mjs
  EXIT_CODE=$?
  echo "[watchdog] Daemon exited (code $EXIT_CODE) at $(date). Restarting in 5s..."
  sleep 5
done
