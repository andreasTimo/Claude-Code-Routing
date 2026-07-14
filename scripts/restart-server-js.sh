#!/usr/bin/env zsh
set -euo pipefail

APP_DIR="${1:-$(pwd)}"
ENV_FILE="$APP_DIR/.env"
SERVER_FILE="$APP_DIR/server.js"

if [[ ! -d "$APP_DIR" ]]; then
  echo "Folder not found: $APP_DIR"
  exit 1
fi

if [[ ! -f "$SERVER_FILE" ]]; then
  echo "server.js not found in: $APP_DIR"
  echo "Run this from the proxy folder, or pass the folder path:"
  echo "  $0 /path/to/anthropic-fallback-proxy"
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/server-$PORT.log"
PID_FILE="$APP_DIR/.server-$PORT.pid"

mkdir -p "$LOG_DIR"

echo "Restarting server.js at $HOST:$PORT"

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping previous PID: $OLD_PID"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

PORT_PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$PORT_PIDS" ]]; then
  echo "Stopping process on port $PORT: $PORT_PIDS"
  kill $PORT_PIDS 2>/dev/null || true
  sleep 1
fi

STILL_RUNNING="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$STILL_RUNNING" ]]; then
  echo "Force stopping process on port $PORT: $STILL_RUNNING"
  kill -9 $STILL_RUNNING 2>/dev/null || true
fi

echo "Starting: node server.js"
echo "Logs: $LOG_FILE"

cd "$APP_DIR"
nohup env HOST="$HOST" PORT="$PORT" node server.js > "$LOG_FILE" 2>&1 &
NEW_PID="$!"
echo "$NEW_PID" > "$PID_FILE"

sleep 1

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "server.js restarted. PID: $NEW_PID"
else
  echo "Process started as PID $NEW_PID, but port $PORT is not listening yet."
  echo "Check logs:"
  echo "  tail -f '$LOG_FILE'"
fi
