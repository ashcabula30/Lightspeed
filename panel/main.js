// Editing Assistant panel: talks to the local helper for the setup checklist,
// the Claude Code chat and the plan usage meter.
const HELPER_URL = 'ws://127.0.0.1:7790/panel';
const RECONNECT_MS = 3000;

const $ = (id) => document.getElementById(id);
const connEl = $('conn');
const checksEl = $('checks');
const checkedAtEl = $('checked-at');
const refreshBtn = $('refresh');
const messagesEl = $('messages');
const activityEl = $('activity');
const promptEl = $('prompt');
const sendBtn = $('send');
const stopBtn = $('stop');
const newChatBtn = $('new-chat');

let ws = null;
let nextId = 1;
let online = false;
let busy = false;
let currentReply = null; // the assistant bubble being streamed into

function request(type, extra = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type, id: nextId++, ...extra }));
  return true;
}

// ---------- connection ----------
function setConnection(isOnline) {
  online = isOnline;
  connEl.textContent = isOnline ? 'Helper connected' : 'Helper offline';
  connEl.className = isOnline ? 'pill pill-on' : 'pill pill-off';
  refreshBtn.disabled = !isOnline;
  if (!isOnline) {
    setBusy(false);
    checksEl.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Start the helper (npm start in the helper folder). Retrying…';
    checksEl.appendChild(li);
  }
  updateControls();
}

function updateControls() {
  sendBtn.disabled = !online || busy;
  newChatBtn.disabled = !online || busy;
  stopBtn.className = busy ? '' : 'hidden';
}

function setBusy(value) {
  busy = value;
  if (!value) activityEl.textContent = '';
  updateControls();
}

// ---------- setup checklist ----------
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

// ---------- usage meter ----------
function formatReset(epochSeconds) {
  if (!epochSeconds) return '';
  const d = new Date(epochSeconds * 1000);
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  if (mins <= 0) return 'Resets now';
  const when = mins < 24 * 60
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const left = mins < 60 ? `${mins} min` : mins < 24 * 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${Math.floor(mins / 1440)} d ${Math.floor((mins % 1440) / 60)} h`;
  return `Resets ${when} (in ${left})`;
}

function setMeter(prefix, window) {
  const pct = window ? Math.round(window.used * 100) : 0;
  $(`${prefix}-text`).textContent = window ? `${pct}% used` : 'n/a';
  const fill = $(`${prefix}-fill`);
  fill.style.width = `${Math.min(100, pct)}%`;
  fill.className = `meter-fill ${pct >= 90 ? 'meter-red' : pct >= 70 ? 'meter-amber' : 'meter-green'}`;
  $(`${prefix}-reset`).textContent = window ? formatReset(window.resetsAt) : '';
}

let lastUsage = null;

function renderUsage(usage) {
  lastUsage = usage;
  $('usage-empty').className = 'hidden';
  $('usage-bars').className = '';
  setMeter('u5', usage.fiveHour);
  setMeter('u7', usage.sevenDay);
  $('usage-updated').textContent = `Updated ${new Date(usage.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

// ---------- chat ----------
function addBubble(kind, text) {
  if (messagesEl.firstElementChild && messagesEl.firstElementChild.className.indexOf('muted') >= 0 && !messagesEl.querySelector('.bubble')) {
    messagesEl.innerHTML = '';
  }
  const div = document.createElement('div');
  div.className = `bubble bubble-${kind}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function sendPrompt() {
  const text = promptEl.value.trim();
  if (!text || busy || !online) return;
  if (request('chat-send', { text })) {
    promptEl.value = '';
    setBusy(true);
    activityEl.textContent = 'Claude is thinking…';
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'hello':
      if (msg.busy) setBusy(true);
      break;
    case 'status':
      renderChecks(msg);
      break;
    case 'usage':
      renderUsage(msg.usage);
      break;
    case 'chat-user':
      addBubble('user', msg.text);
      currentReply = null;
      setBusy(true);
      break;
    case 'chat-block':
      // A new text block starts after tool use; keep one bubble per block.
      if (currentReply && currentReply.textContent) currentReply = null;
      break;
    case 'chat-delta':
      if (!currentReply) currentReply = addBubble('assistant', '');
      currentReply.textContent += msg.text;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      activityEl.textContent = 'Claude is replying…';
      break;
    case 'chat-tool':
      activityEl.textContent = `Using ${msg.name}${msg.input ? ': ' + msg.input : ''}`;
      currentReply = null;
      break;
    case 'chat-done':
      if (msg.isError) addBubble('error', msg.error || 'Claude reported an error.');
      if (msg.denied && msg.denied.length) addBubble('note', `Blocked (needs approval, coming later): ${[...new Set(msg.denied)].join(', ')}`);
      currentReply = null;
      setBusy(false);
      break;
    case 'chat-error':
      addBubble('error', msg.error);
      currentReply = null;
      setBusy(false);
      break;
    case 'chat-cleared':
      messagesEl.innerHTML = '<div class="muted small">New conversation.</div>';
      currentReply = null;
      break;
    case 'error':
      console.error('Helper error:', msg.error);
      break;
    default:
      break;
  }
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
    handleMessage(msg);
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
sendBtn.addEventListener('click', sendPrompt);
stopBtn.addEventListener('click', () => request('chat-stop'));
newChatBtn.addEventListener('click', () => request('chat-new'));
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
// Keep the reset countdowns current.
setInterval(() => { if (lastUsage) renderUsage(lastUsage); }, 60000);

setConnection(false);
connect();
