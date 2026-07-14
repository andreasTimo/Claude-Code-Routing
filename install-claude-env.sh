#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP_DIR/.env"
ZSHRC="$HOME/.zshrc"
ZSHENV="$HOME/.zshenv"
START_MARKER="# >>> anthropic-fallback-proxy >>>"
END_MARKER="# <<< anthropic-fallback-proxy <<<"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE"
  echo "Create it first: cp .env.example .env"
  exit 1
fi

proxy_token="$(
  awk -F= '
    $1 == "PROXY_AUTH_TOKEN" {
      value=$0
      sub(/^PROXY_AUTH_TOKEN=/, "", value)
      gsub(/^["'\'' ]+|["'\'' ]+$/, "", value)
      print value
    }
  ' "$ENV_FILE"
)"

if [ -z "$proxy_token" ]; then
  proxy_token="anything"
fi

write_shell_block() {
  local target_file="$1"
  touch "$target_file"

  local tmp_file
  tmp_file="$(mktemp)"
  awk -v start="$START_MARKER" -v end="$END_MARKER" '
    $0 == start { skip = 1; next }
    $0 == end { skip = 0; next }
    skip != 1 { print }
  ' "$target_file" > "$tmp_file"

  cat >> "$tmp_file" <<EOF

$START_MARKER
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_AUTH_TOKEN="$proxy_token"
$END_MARKER
EOF

  mv "$tmp_file" "$target_file"
}

write_shell_block "$ZSHRC"
write_shell_block "$ZSHENV"

echo "Updated $ZSHRC"
echo "Updated $ZSHENV"
echo "New Claude Code shells will use:"
echo "  ANTHROPIC_BASE_URL=http://127.0.0.1:8787"
echo "  ANTHROPIC_AUTH_TOKEN=$(printf '%s' "$proxy_token" | sed 's/./*/g')"
echo
echo "Now close the current Claude Code process/terminal, open a new terminal, then run:"
echo "  claude"
