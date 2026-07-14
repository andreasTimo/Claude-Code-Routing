#!/usr/bin/env zsh
set -euo pipefail

APP_DIR="${1:-$(pwd)}"
ENV_FILE="$APP_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/proxy-$PORT.log"

mkdir -p "$LOG_DIR"

echo "Restarting proxy at $HOST:$PORT"

PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$PIDS" ]]; then
  echo "Stopping existing process: $PIDS"
  kill $PIDS 2>/dev/null || true
  sleep 1

  STILL_RUNNING="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$STILL_RUNNING" ]]; then
    echo "Force stopping: $STILL_RUNNING"
    kill -9 $STILL_RUNNING 2>/dev/null || true
  fi
fi

if [[ -n "${START_CMD:-}" ]]; then
  CMD="$START_CMD"
elif [[ -f "$APP_DIR/package.json" ]] && node -e "const p=require('$APP_DIR/package.json'); process.exit(p.scripts?.dev ? 0 : 1)" 2>/dev/null; then
  CMD="npm run dev"
elif [[ -f "$APP_DIR/package.json" ]] && node -e "const p=require('$APP_DIR/package.json'); process.exit(p.scripts?.start ? 0 : 1)" 2>/dev/null; then
  CMD="npm start"
elif [[ -f "$APP_DIR/server.js" ]]; then
  CMD="node server.js"
else
  echo "No start command found."
  echo "Set START_CMD in .env, for example: START_CMD='node server.js'"
  exit 1
fi

echo "Starting: $CMD"
echo "Logs: $LOG_FILE"

cd "$APP_DIR"
nohup zsh -lc "$CMD" > "$LOG_FILE" 2>&1 &
NEW_PID="$!"

sleep 1
if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Proxy restarted. PID: $NEW_PID"
else
  echo "Started process PID $NEW_PID, but port $PORT is not listening yet."
  echo "Check logs: tail -f '$LOG_FILE'"
fi
