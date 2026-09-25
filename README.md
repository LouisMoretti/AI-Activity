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
  "command": "input=$(cat); printf '%s' \"$input\" | setsid -f python3 -c \"import sys,json,os,glob,fcntl,signal,urllib.request as R;signal.alarm(900);N=chr(10);exec('def J(l):'+N+' d=json.JSONDecoder();i=0;r=[]'+N+' while 1:'+N+'  try: o,i=d.raw_decode(l,i)'+N+'  except Exception: return r'+N+'  r.append(o)');H=os.path.expanduser('~/.cache/ai-activity');os.makedirs(H,exist_ok=True);L=open(H+'/lock','w');fcntl.flock(L,fcntl.LOCK_EX);S=H+'/offsets.json';st=([o for o in (J(open(S).read()) if os.path.exists(S) else []) if isinstance(o,dict)] or [{}])[0];s=([o for o in J(sys.stdin.read()) if isinstance(o,dict)] or [{}])[0];off=lambda f,z:st.get(f,0) if st.get(f,0)<=z else 0;F=[(f,os.path.getsize(f)) for f in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'),recursive=True)];F=[(f,off(f,z)) for f,z in F if z!=st.get(f)];NO={};RD=lambda f,o:(lambda b:b.seek(o) and 0 or b.read())(open(f,'rb'));E=[(m['id'],(u.get('output_tokens') or 0,os.path.basename(f)[:-6]==o.get('sessionId')),{'message_id':m['id'],'session_id':o.get('sessionId'),'model':m.get('model'),'occurred_at':int(__import__('datetime').datetime.fromisoformat(o['timestamp'].replace('Z','+00:00')).timestamp()),'usage':{k:u.get(k) or 0 for k in ('input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens')}}) for f,o0 in F for d in [RD(f,o0)] for k in [d.rfind(bytes([10]))+1] if NO.__setitem__(f,o0+k) is None for l in d[:k].decode('utf-8','replace').split(N) for o in J(l) if isinstance(o,dict) and o.get('type')=='assistant' and o.get('timestamp') for m in [o.get('message')] if isinstance(m,dict) and isinstance(m.get('id'),str) and isinstance(m.get('usage'),dict) for u in [m['usage']]];M=list({i:e for i,q,e in sorted(E,key=lambda x:x[1])}.values());c=s.get('context_window') or {};B=dict(rate_limits=s.get('rate_limits') or {},context=dict(session_id=s.get('session_id'),used_pct=c.get('used_percentage'),window_size=c.get('context_window_size')),occurred_at=int(__import__('time').time()));P=lambda b:R.urlopen(R.Request('<server>/api/ingest/claude-code',data=json.dumps(b).encode(),headers={'Authorization':'Bearer <device key>','Content-Type':'application/json'}),timeout=60);[P(dict(B,messages=M[i:i+400])) for i in range(0,max(len(M),1),400)];st.update(NO);open(S+'.tmp','w').write(json.dumps(st));os.replace(S+'.tmp',S)\" >/dev/null 2>&1"
}
```

It needs `python3` and `setsid` (util-linux), both standard on Linux, and
runs as your user: no root, no script to install, nothing printed in the
status line.

What it does on every status line refresh:

- Reads what was added to every transcript under `~/.claude/projects`
  (sessions and subagents, all projects) since the last successful upload,
  and sends **one entry per Anthropic message id** with its token counts.
  Prompts and replies never leave the device, only ids, model, time and
  counts.
- The first refresh therefore sends every transcript still on disk (Claude
  Code keeps about 30 days by default): that is the import of past
  sessions. It also replaces the rows the old snapshot collector sent for
  those sessions, which counted most API calls twice.
- How far each file was sent is kept in `~/.cache/ai-activity/offsets.json`
  and only moves forward once the server accepted everything, so nothing
  is lost while the server is down: the next refresh sends the backlog.
  Delete that file to send everything again (safe: the server stores each
  message id once), or after pointing the device at another server.
- The server stores each message id once. Claude Code sometimes writes a
  partial entry (a few output tokens) before the final one; the final
  counts replace it.
- `setsid -f` starts the upload in its own session and returns at once.
  Claude Code cancels a status line command when the next refresh comes;
  the upload keeps running. Uploads wait for each other (a lock in
  `~/.cache/ai-activity`) and give up after 15 minutes.
- Also sends the 5-hour and 7-day quotas and the context fill.

The tool is part of the URL (`/api/ingest/claude-code`); a bare
`/api/ingest` answers `404`. See `AGENTS.md` §5 for the payload contract.
