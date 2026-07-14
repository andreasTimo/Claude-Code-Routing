#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_ID="com.local.anthropic-fallback-proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_ID.plist"
NODE_PATH="$(command -v node)"

if [ ! -f "$APP_DIR/.env" ]; then
  echo "Missing $APP_DIR/.env"
  echo "Create it first: cp .env.example .env"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_ID</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$APP_DIR/server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$APP_DIR/proxy.log</string>

  <key>StandardErrorPath</key>
  <string>$APP_DIR/proxy.err.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$PLIST_ID"

echo "Installed and started $PLIST_ID"
echo "Proxy logs:"
echo "  $APP_DIR/proxy.log"
echo "  $APP_DIR/proxy.err.log"
echo
echo "Check health:"
echo "  curl http://127.0.0.1:8787/health"
