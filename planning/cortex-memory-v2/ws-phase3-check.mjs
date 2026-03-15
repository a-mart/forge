const [, , url, mode, arg1, arg2] = process.argv;
if (!url || !mode) {
  console.error('Usage: node ws-phase3-check.mjs <wsUrl> <mode> [args]');
  process.exit(1);
}

const ws = new WebSocket(url);
const events = [];
const timeoutMs = 30000;
let sent = false;
let done = false;

function finish(code, payload) {
  if (done) return;
  done = true;
  if (payload) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  try { ws.close(); } catch {}
  setTimeout(() => process.exit(code), 20);
}

const timer = setTimeout(() => finish(2, { error: 'timeout', mode, events: events.slice(-20) }), timeoutMs);

ws.addEventListener('open', () => {
  if ((mode === 'subscribe-manager' || mode === 'send-message') && arg1) {
    ws.send(JSON.stringify({ type: 'subscribe', agentId: arg1 }));
  } else {
    ws.send(JSON.stringify({ type: 'subscribe' }));
  }
});

ws.addEventListener('message', (raw) => {
  const event = JSON.parse(String(raw.data));
  events.push(event);

  if (mode === 'create-manager') {
    if (event.type === 'ready' && !sent) {
      sent = true;
      ws.send(JSON.stringify({
        type: 'create_manager',
        name: arg1 || 'phase3-fresh-manager',
        cwd: arg2 || process.cwd(),
        requestId: 'phase3-create-1'
      }));
      return;
    }
    if (event.type === 'manager_created') {
      clearTimeout(timer);
      finish(0, { managerId: event.manager?.agentId, event });
      return;
    }
    if (event.type === 'error' && event.requestId === 'phase3-create-1') {
      clearTimeout(timer);
      finish(3, { error: 'create_manager_failed', event });
      return;
    }
  }

  if (mode === 'send-message') {
    const messageText = arg2 || 'phase3 auth check';
    if ((event.type === 'conversation_history' || event.type === 'agents_snapshot' || event.type === 'ready') && !sent) {
      sent = true;
      ws.send(JSON.stringify({ type: 'user_message', text: messageText }));
      return;
    }
    if (event.type === 'conversation_message' && event.source === 'assistant_message') {
      clearTimeout(timer);
      finish(0, { result: 'assistant_message', event });
      return;
    }
    if (event.type === 'error') {
      clearTimeout(timer);
      finish(0, { result: 'error_event', event });
      return;
    }
  }
});

ws.addEventListener('error', (err) => {
  clearTimeout(timer);
  finish(4, { error: String(err?.message || err) });
});
