# CRT-07 Existing Copied Session Transcript in UI

Date: 2026-03-15 (CDT)  
Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`  
UI claim: **existing copied session transcript can be loaded in the UI**  
Result: **PASS (real UI proof, bounded scope)**

## What I proved
Using a fresh `agent-browser` session against the isolated copied-runtime UI, I selected an existing copied session from the sidebar and verified that its persisted transcript rendered in the chat pane.

Chosen existing session:
- Profile: `middleman-project`
- Session: `session-history-visability`
- Copied session file:
  `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/middleman-project/sessions/session-history-visability/session.jsonl`

## Isolation proof
The already-running backend/UI pair on `47387/47389` was confirmed to be the copied env, not production:

```bash
ps eww -p 71914 | tr ' ' '\n' | rg '^MIDDLEMAN_(DATA_DIR|PORT)='
```

Observed:
- `MIDDLEMAN_PORT=47387`
- `MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate`

## Exact UI steps
```bash
agent-browser --session crt07-ui-history open http://127.0.0.1:47389
agent-browser --session crt07-ui-history snapshot --json > .tmp/crt07-ui-history-snapshot-full-1.json
agent-browser --session crt07-ui-history click @e45
agent-browser --session crt07-ui-history wait 1500
agent-browser --session crt07-ui-history snapshot --json > .tmp/crt07-ui-history-snapshot-2.json
agent-browser --session crt07-ui-history screenshot .tmp/crt07-ui-history-session-history-visability.png
```

Key pre-click snapshot evidence:
- Sidebar showed existing copied session button `session history visability` as ref `@e45`.

Key post-click snapshot evidence:
- Main heading changed to `middleman-project › session history visability`.
- Transcript paragraphs rendered in the main pane, including:
  - `I wanted to see if you could help look into an issue...`
  - `Looking into this — I'll investigate the session history loading issue...`
  - `Found the root cause. Here's the chain:`
  - `Fix is implemented and validated. Single file change:`
  - Committed as `6aff004`. You'll need a restart to pick up the change.

## Persisted-data match
I extracted the copied session's persisted `conversation_message` entries directly from the isolated copied data:

```bash
node - <<'NODE' > .tmp/crt07-ui-history-session-file.json
const fs=require('fs');
const p='/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/middleman-project/sessions/session-history-visability/session.jsonl';
const lines=fs.readFileSync(p,'utf8').trim().split('\n').map(l=>JSON.parse(l));
const msgs=lines.filter(x=>x.customType==='swarm_conversation_entry').map(x=>x.data).filter(x=>x&&x.type==='conversation_message');
console.log(JSON.stringify({path:p,totalConversationMessages:msgs.length,messages:msgs.map(({timestamp,role,text})=>({timestamp,role,text}))},null,2));
NODE
```

Observed from the copied file:
- `totalConversationMessages: 6`
- First user message exactly begins:
  - `I wanted to see if you could help look into an issue that I think has been caused by a recent change...`
- Final assistant message exactly is:
  - `Committed as \`6aff004\`. You'll need a restart to pick up the change.`

Those exact messages also appeared in the rendered UI snapshot after selecting the session.

## Preexisting-session proof
The selected session file predates this test run:

```bash
stat -f 'session file mtime=%Sm size=%z bytes' -t '%Y-%m-%d %H:%M:%S %Z' \
  /Users/adam/.middleman-cortex-memory-v2-migrate/profiles/middleman-project/sessions/session-history-visability/session.jsonl
```

Observed:
- `session file mtime=2026-03-15 11:00:20 CDT`
- `size=478027 bytes`

The UI proof capture occurred around `21:51 CDT`, so this was not a session created by the test.

## Evidence files
Durable copies saved under the worktree:
- `planning/cortex-memory-v2/raw/crt07-ui-history-snapshot.json`
- `planning/cortex-memory-v2/raw/crt07-ui-history-session-file.json`
- `planning/cortex-memory-v2/raw/crt07-ui-history-session-history-visability.png`

## Honest scope boundary
What this pass proves:
- an existing session from the copied isolated env appears in the UI sidebar
- selecting it loads its persisted transcript into the main chat pane
- rendered text matches persisted copied data on disk

What this pass does **not** prove:
- every large/trimmed session renders fully without pagination/byte-budget limits
- hidden sessions behind `Show more` were separately exercised
- fresh-env history loading

## Verdict
**CRT-07 PASS:** the copied isolated UI can load and render an existing copied session transcript.