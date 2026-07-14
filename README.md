# Claude-Code-Routing

Small helper repo for routing Claude Code through a local Anthropic-compatible fallback proxy.

## Included

- `scripts/restart-server-js.sh` restarts a `server.js` proxy folder on its configured host/port.
- `scripts/restart-proxy.sh` restarts a proxy folder using `START_CMD`, npm scripts, or `node server.js`.

## Example

```bash
scripts/restart-server-js.sh /path/to/anthropic-fallback-proxy
```
