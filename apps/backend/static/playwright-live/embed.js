const previewId = document.body.dataset.previewId ?? '';
const titleEl = document.getElementById('pw-live-title');
const statusEl = document.getElementById('pw-live-status');
const frameEl = document.getElementById('pw-live-frame');
const emptyEl = document.getElementById('pw-live-empty');
const previewIdEl = document.getElementById('pw-live-preview-id');
const controllerEl = document.getElementById('pw-live-controller');
const frameCountEl = document.getElementById('pw-live-frame-count');
const logEl = document.getElementById('pw-live-log');

let frameCount = 0;
let controllerSocket = null;

function log(message) {
  if (!logEl) return;
  const timestamp = new Date().toISOString();
  logEl.textContent = `${timestamp} ${message}\n${logEl.textContent}`.slice(0, 12000);
}

function setStatus(value) {
  if (statusEl) statusEl.textContent = value;
}

function setTitle(value) {
  if (titleEl) titleEl.textContent = value;
}

function setFrameFromPayload(payload) {
  const data = payload?.data ?? payload?.frame?.data ?? null;
  if (typeof data !== 'string' || !data) {
    return false;
  }

  if (frameEl) {
    frameEl.src = data.startsWith('data:') ? data : `data:image/jpeg;base64,${data}`;
    frameEl.hidden = false;
  }
  if (emptyEl) {
    emptyEl.hidden = true;
  }

  frameCount += 1;
  if (frameCountEl) {
    frameCountEl.textContent = String(frameCount);
  }
  return true;
}

function handleControllerMessage(event) {
  const raw = typeof event.data === 'string' ? event.data : '';
  if (!raw) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    log('Received non-JSON controller payload');
    return;
  }

  const type = typeof payload?.type === 'string' ? payload.type : null;
  if (type === 'tabs' && Array.isArray(payload.tabs)) {
    const selectedTab = payload.tabs.find((tab) => tab?.selected) ?? payload.tabs[0];
    if (selectedTab?.title) {
      setTitle(selectedTab.title);
    }
  }

  if (type === 'frame' || payload?.frame || payload?.data) {
    if (setFrameFromPayload(payload)) {
      setStatus('active');
    }
    return;
  }

  if (type === 'error') {
    setStatus('error');
    log(`Controller error: ${payload.message ?? 'unknown error'}`);
    return;
  }

  if (type) {
    log(`Controller event: ${type}`);
  }
}

async function bootstrap() {
  if (!previewId) {
    setStatus('idle');
    log('No previewId provided.');
    return;
  }

  previewIdEl && (previewIdEl.textContent = previewId);
  setStatus('starting');
  log(`Bootstrapping preview ${previewId}`);

  const response = await fetch(`/playwright-live/api/previews/${encodeURIComponent(previewId)}/bootstrap`, {
    cache: 'no-store',
  });

  if (!response.ok) {
    const message = await response.text();
    setStatus('error');
    log(`Bootstrap failed: ${message}`);
    return;
  }

  const payload = await response.json();
  const bootstrap = payload?.bootstrap;
  const controllerWsUrl = bootstrap?.controllerWsUrl || bootstrap?.controllerProxyUrl;
  const sessionName = bootstrap?.sessionName || bootstrap?.preview?.sessionName || 'Playwright session';

  setTitle(sessionName);
  controllerEl && (controllerEl.textContent = controllerWsUrl ?? 'unavailable');

  if (typeof controllerWsUrl !== 'string' || !controllerWsUrl) {
    setStatus('error');
    log('Bootstrap missing controller WebSocket URL.');
    return;
  }

  controllerSocket = new WebSocket(controllerWsUrl);
  controllerSocket.addEventListener('open', () => {
    setStatus('active');
    log('Controller proxy connected.');
  });
  controllerSocket.addEventListener('message', handleControllerMessage);
  controllerSocket.addEventListener('close', () => {
    setStatus('expired');
    log('Controller proxy disconnected.');
  });
  controllerSocket.addEventListener('error', () => {
    setStatus('error');
    log('Controller proxy errored.');
  });
}

window.addEventListener('beforeunload', () => {
  if (controllerSocket && controllerSocket.readyState === WebSocket.OPEN) {
    controllerSocket.close();
  }
});

void bootstrap().catch((error) => {
  setStatus('error');
  log(error instanceof Error ? error.message : String(error));
});
