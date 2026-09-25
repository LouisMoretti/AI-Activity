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
  "command": "input=$(cat); printf '%s' \"$input\" | setsid -f python3 -c \"import sys,json,os,glob,time,fcntl,collections,datetime,urllib.request as R;exec('def J(l):'+chr(10)+' try: return json.loads(l)'+chr(10)+' except Exception: return {}');L=open(os.path.join(os.environ.get('XDG_RUNTIME_DIR') or '/tmp','ai-activity-'+str(os.getuid())+'.lock'),'w');fcntl.flock(L,fcntl.LOCK_EX|fcntl.LOCK_NB);s=json.load(sys.stdin);t=s.get('transcript_path') or '';F=[t]+[f for f in glob.glob(t[:-6]+'/subagents/*.jsonl') if time.time()-os.path.getmtime(f)<600];O=[J(l) for f in F if os.path.isfile(f) for l in collections.deque(open(f,errors='replace'),300) if l[-1:]==chr(10)];ts=lambda v:int(datetime.datetime.fromisoformat(v.replace('Z','+00:00')).timestamp());M=sorted([{'message_id':m['id'],'session_id':o.get('sessionId'),'model':m.get('model'),'occurred_at':ts(o['timestamp']),'usage':{k:m['usage'].get(k) or 0 for k in ('input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens')}} for o in O if o.get('type')=='assistant' and o.get('timestamp') for m in [o.get('message')] if isinstance(m,dict) and m.get('id') and isinstance(m.get('usage'),dict)],key=lambda x:x['usage']['output_tokens']);M=list({x['message_id']:x for x in M}.values());c=s.get('context_window') or {};B=dict(rate_limits=s.get('rate_limits') or {},context=dict(session_id=s.get('session_id'),used_pct=c.get('used_percentage'),window_size=c.get('context_window_size')),occurred_at=int(time.time()));P=lambda b:R.urlopen(R.Request('<server>/api/ingest/claude-code',data=json.dumps(b).encode(),headers={'Authorization':'Bearer <device key>','Content-Type':'application/json'}),timeout=20);[P(dict(B,messages=M[i:i+400])) for i in range(0,max(len(M),1),400)]\" >/dev/null 2>&1"
}
```

It needs `python3` and `setsid` (util-linux), both standard on Linux, and
runs as your user: no root, no script to install, nothing printed in the
status line.

What it does on every status line refresh:

- Reads the last 300 lines of the session transcript (and of subagent
  transcripts touched in the last 10 minutes) and sends **one entry per
  Anthropic message id** with its token counts. Prompts and replies never
  leave the device, only ids, model, time and counts.
- The server stores each message id once. Claude Code sometimes writes a
  partial entry (a few output tokens) before the final one; the final
  counts replace it. Re-sending the same messages changes nothing, so
  every refresh can safely resend the recent ones.
- `setsid -f` starts the upload in its own session and returns at once.
  Claude Code cancels a status line command when the next refresh comes;
  the upload keeps running. A lock skips a refresh while the previous
  upload is still going; the next refresh sends what it missed.
- Also sends the 5-hour and 7-day quotas and the context fill.

### Import past sessions (once)

Run this on the device to send every transcript still on disk (Claude Code
keeps about 30 days by default). Safe to run again. It also replaces the
rows of those sessions sent by the old snapshot collector, which counted
most API calls twice:

```bash
python3 -c "import sys,json,os,glob,time,fcntl,collections,datetime,urllib.request as R;exec('def J(l):'+chr(10)+' try: return json.loads(l)'+chr(10)+' except Exception: return {}');F=glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'),recursive=True);O=[J(l) for f in F for l in open(f,errors='replace') if l[-1:]==chr(10)];ts=lambda v:int(datetime.datetime.fromisoformat(v.replace('Z','+00:00')).timestamp());M=sorted([{'message_id':m['id'],'session_id':o.get('sessionId'),'model':m.get('model'),'occurred_at':ts(o['timestamp']),'usage':{k:m['usage'].get(k) or 0 for k in ('input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens')}} for o in O if o.get('type')=='assistant' and o.get('timestamp') for m in [o.get('message')] if isinstance(m,dict) and m.get('id') and isinstance(m.get('usage'),dict)],key=lambda x:x['usage']['output_tokens']);M=list({x['message_id']:x for x in M}.values());B=dict();P=lambda b:R.urlopen(R.Request('<server>/api/ingest/claude-code',data=json.dumps(b).encode(),headers={'Authorization':'Bearer <device key>','Content-Type':'application/json'}),timeout=20);[P(dict(B,messages=M[i:i+400])) for i in range(0,max(len(M),1),400)]"
```

The tool is part of the URL (`/api/ingest/claude-code`); a bare
`/api/ingest` answers `404`. See `AGENTS.md` §5 for the payload contract.
