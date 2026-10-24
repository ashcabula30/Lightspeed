// Editing Assistant panel: connects to the local helper and shows the setup checklist.
const HELPER_URL = 'ws://127.0.0.1:7790/panel';
const RECONNECT_MS = 3000;

const connEl = document.getElementById('conn');
const checksEl = document.getElementById('checks');
const checkedAtEl = document.getElementById('checked-at');
const refreshBtn = document.getElementById('refresh');

let ws = null;
let nextId = 1;

function setConnection(online) {
  connEl.textContent = online ? 'Helper connected' : 'Helper offline';
  connEl.className = online ? 'pill pill-on' : 'pill pill-off';
  refreshBtn.disabled = !online;
  if (!online) {
    checksEl.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Start the helper (npm start in the helper folder). Retrying…';
    checksEl.appendChild(li);
  }
}

function request(type, extra = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, id: nextId++, ...extra }));
}

const ICON = { ok: '✓', warn: '!', missing: '✗' };

function renderChecks(status) {
  checksEl.innerHTML = '';
  for (const c of status.checks) {
    const li = document.createElement('li');
    li.className = `check check-${c.state}`;
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = ICON[c.state] || '?';
    const body = document.createElement('div');
    body.className = 'body';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = c.label;
    const detail = document.createElement('div');
    detail.className = 'detail small';
    detail.textContent = c.detail;
    body.appendChild(title);
    body.appendChild(detail);
    li.appendChild(icon);
    li.appendChild(body);
    checksEl.appendChild(li);
  }
  checkedAtEl.textContent = `Checked ${new Date(status.checkedAt).toLocaleTimeString()}`;
}

function connect() {
  try {
    ws = new WebSocket(HELPER_URL);
  } catch (err) {
    setConnection(false);
    setTimeout(connect, RECONNECT_MS);
    return;
  }
  ws.onopen = () => {
    setConnection(true);
    checksEl.innerHTML = '<li class="muted">Checking…</li>';
    request('status');
  };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'status') renderChecks(msg);
    else if (msg.type === 'error') console.error('Helper error:', msg.error);
  };
  ws.onclose = () => {
    setConnection(false);
    setTimeout(connect, RECONNECT_MS);
  };
  ws.onerror = () => { /* onclose follows and handles the retry */ };
}

refreshBtn.addEventListener('click', () => {
  checksEl.innerHTML = '<li class="muted">Checking…</li>';
  request('status');
});

setConnection(false);
connect();
