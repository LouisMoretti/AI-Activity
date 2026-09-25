# AI Activity

## Send Claude Code usage from a device

1. Create a device key on the server: `npm run gen-key -- "my-laptop"`, or
   **Settings → Devices** in the dashboard. The key is shown once.
2. Add this to `~/.claude/settings.json` on the device, replacing
   `<server>` (e.g. `http://localhost:3000` or your tunnel URL) and
   `<device key>`:

```json
"statusLine": {
  "type": "command",
  "command": "input=$(cat); { printf \"%s\" \"$input\" | curl -sf --max-time 8 -X POST '<server>/api/ingest/claude-code' -H 'Authorization: Bearer <device key>' -H 'content-type: application/json' --data @- >/dev/null 2>&1; } >/dev/null 2>&1 & echo '[claude]'"
}
```

The command posts the raw statusLine JSON to the server in the background
and prints `[claude]` as the status line, so Claude Code never waits on the
network. It keeps no spool: events sent while the server is unreachable are
lost. See `AGENTS.md` §5 for the payload contract and a collector that
spools and replays.

The tool is part of the URL (`/api/ingest/claude-code`); a bare
`/api/ingest` answers `404`.
