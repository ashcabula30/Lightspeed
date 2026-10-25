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
  if (typeof acUpdateControls === 'function') acUpdateControls();
  if (typeof gfxUpdateControls === 'function') gfxUpdateControls();
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
  if (handleAutocut(msg)) return;
  if (handleGraphics(msg)) return;
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

// ---------- auto-cut ----------
const acAnalyzeBtn = $('ac-analyze');
const acApplyBtn = $('ac-apply');
let acBusy = false;

function mmss(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function acSettings() {
  const thr = $('ac-threshold').value.trim();
  return {
    pauseSeconds: Number($('ac-pause').value) || 0.5,
    thresholdDb: thr === '' ? 'auto' : Number(thr),
    removeRetakes: $('ac-retakes').checked,
    removeUms: $('ac-ums').checked,
    slatePhrases: $('ac-slates').value.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

function acUpdateControls() {
  acAnalyzeBtn.disabled = !online || acBusy;
  acApplyBtn.disabled = !online || acBusy;
}

function listBlock(title, items) {
  const wrap = document.createElement('div');
  wrap.className = 'listblock';
  const h = document.createElement('div');
  h.className = 'title small';
  h.textContent = title;
  wrap.appendChild(h);
  for (const text of items) {
    const d = document.createElement('div');
    d.className = 'detail small';
    d.textContent = text;
    wrap.appendChild(d);
  }
  return wrap;
}

function renderAnalysis(r) {
  $('ac-results').className = '';
  $('ac-done').className = 'hidden';
  $('ac-seq').textContent = r.sequence.name;
  const st = r.stats;
  $('ac-summary').textContent = st.cuts
    ? `${st.cuts} cuts: ${mmss(st.before)} → ${mmss(st.after)} (saves ${mmss(st.removedSeconds)})`
    : 'Nothing to cut with these settings.';
  $('ac-breakdown').textContent = `${st.retakes} retakes · ${st.ums} ums/breaths · ${st.pauses} pauses · threshold ${r.threshold} dB`;

  const review = [];
  for (const x of r.review.unconfidentRetakes) review.push(`${mmss(x.at)}  unsure retake: "${x.removedText}"`);
  for (const x of r.review.longUnworded) review.push(`${mmss(x.at)}  ${x.seconds}s sound cut as an um (check it's not a word)`);
  for (const x of r.review.repeats) review.push(`${mmss(x.at)}  possible repeat, not cut: "${x.text}"`);
  const reviewEl = $('ac-review');
  reviewEl.innerHTML = '';
  if (review.length) reviewEl.appendChild(listBlock('Check after applying', review));

  const rtEl = $('ac-retakes-list');
  rtEl.innerHTML = '';
  if (r.retakes.length) rtEl.appendChild(listBlock('Retakes to remove', r.retakes.map((x) => `${mmss(x.at)}  "${x.removedText}"`)));
  acApplyBtn.className = st.cuts ? '' : 'hidden';
}

function setAcProgress(label, done, total) {
  $('ac-progress').textContent = label || '';
  const track = $('ac-bar-track');
  if (total) {
    track.className = 'meter-track';
    $('ac-bar').style.width = `${Math.round((done / total) * 100)}%`;
  } else {
    track.className = 'meter-track hidden';
  }
}

acAnalyzeBtn.addEventListener('click', () => {
  $('ac-results').className = 'hidden';
  $('ac-done').className = 'hidden';
  setAcProgress('Starting…');
  request('autocut-analyze', { settings: acSettings() });
});
acApplyBtn.addEventListener('click', () => {
  setAcProgress('Starting…', 0, 1);
  request('autocut-apply');
});

function handleAutocut(msg) {
  switch (msg.type) {
    case 'autocut-busy':
      acBusy = msg.busy;
      acUpdateControls();
      if (!msg.busy && $('ac-progress').textContent === 'Starting…') setAcProgress('');
      return true;
    case 'autocut-progress':
      setAcProgress(msg.label, msg.done, msg.total);
      return true;
    case 'autocut-result':
      setAcProgress('');
      renderAnalysis(msg.result);
      return true;
    case 'autocut-applied': {
      const r = msg.result;
      setAcProgress('');
      $('ac-results').className = 'hidden';
      const done = $('ac-done');
      done.className = 'bubble bubble-note';
      done.textContent = `Done: ${r.applied} cuts applied. ${r.durationAfter ? `Now ${mmss(r.durationAfter)}. ` : ''}Backup: "${r.backup.name}".`;
      return true;
    }
    case 'autocut-error': {
      setAcProgress('');
      const done = $('ac-done');
      done.className = 'bubble bubble-error';
      done.textContent = msg.error;
      return true;
    }
    default:
      return false;
  }
}

// ---------- graphics ----------
const gfxFillBtn = $('gfx-fill');
const gfxMakeBtn = $('gfx-make');
let gfxBusy = false;

function gfxShowFields() {
  const kind = $('gfx-kind').value;
  $('gfx-card-fields').className = kind === 'card' ? '' : 'hidden';
  $('gfx-keyword-fields').className = kind === 'keywords' ? '' : 'hidden';
  $('gfx-quote-fields').className = kind === 'quote' ? '' : 'hidden';
}

function gfxUpdateControls() {
  gfxFillBtn.disabled = !online || gfxBusy;
  gfxMakeBtn.disabled = !online || gfxBusy;
}

function gfxSpec() {
  const kind = $('gfx-kind').value;
  const durationSeconds = Number($('gfx-duration').value) || 3.5;
  if (kind === 'card') {
    return { kind, text: $('gfx-text').value.trim(), highlight: $('gfx-highlight').value.trim() || null, look: $('gfx-look').value, durationSeconds };
  }
  if (kind === 'keywords') {
    const words = $('gfx-words').value.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => (l.startsWith('!') ? { text: l.slice(1).trim(), red: true } : { text: l, red: false }));
    return { kind, words, durationSeconds };
  }
  return { kind, text: $('gfx-quote').value.trim(), durationSeconds };
}

function gfxApplySpec(spec) {
  $('gfx-kind').value = spec.kind;
  gfxShowFields();
  if (spec.durationSeconds) $('gfx-duration').value = String(spec.durationSeconds);
  if (spec.kind === 'card') {
    $('gfx-text').value = spec.text || '';
    $('gfx-highlight').value = spec.highlight || '';
    if (spec.look) $('gfx-look').value = spec.look;
  } else if (spec.kind === 'keywords') {
    $('gfx-words').value = (spec.words || []).map((w) => (w.red ? '!' : '') + w.text).join('\n');
  } else {
    $('gfx-quote').value = spec.text || '';
  }
}

function gfxNote(kind, text) {
  const el = $('gfx-done');
  el.className = `bubble bubble-${kind}`;
  el.textContent = text;
}

$('gfx-kind').addEventListener('change', gfxShowFields);
gfxFillBtn.addEventListener('click', () => {
  $('gfx-done').className = 'hidden';
  request('gfx-fill', { kind: $('gfx-kind').value, prompt: $('gfx-prompt').value });
});
gfxMakeBtn.addEventListener('click', () => {
  $('gfx-done').className = 'hidden';
  $('gfx-progress').textContent = 'Starting…';
  request('gfx-make', { spec: gfxSpec() });
});

function handleGraphics(msg) {
  switch (msg.type) {
    case 'gfx-busy':
      gfxBusy = msg.busy;
      gfxUpdateControls();
      if (!msg.busy) $('gfx-progress').textContent = '';
      return true;
    case 'gfx-progress':
      $('gfx-progress').textContent = msg.label;
      return true;
    case 'gfx-filled':
      gfxApplySpec(msg.spec);
      gfxNote('note', msg.usedTranscript ? 'Filled from what is said at the playhead. Check the wording, then Render & place.' : 'Filled from your description. Check it, then Render & place.');
      return true;
    case 'gfx-placed': {
      const r = msg.result;
      gfxNote('note', `Placed on V${r.track} at ${mmss(r.start)} in "${r.sequence}" (${r.durationSeconds}s).`);
      return true;
    }
    case 'gfx-error':
      gfxNote('error', msg.error);
      return true;
    default:
      return false;
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
