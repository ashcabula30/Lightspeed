// Editing Assistant panel: talks to the local helper for auto-cut, the Claude Code chat,
// the setup checklist and the plan usage meter. Clients and review live in features.js.
// UXP's DOM is partial: stick to className, getAttribute and plain loops (no dataset,
// classList.toggle(force), NodeList spreading or Element.remove()).
const HELPER_URL = 'ws://127.0.0.1:7790/panel';
const RECONNECT_MS = 3000;
const STORE_KEY = 'ea-open-panels';
const USAGE_WARN = 0.85; // ask before sending a chat message past 85% of the 5-hour limit

const $ = (id) => document.getElementById(id);
const IN_UXP = (() => {
  try { return typeof require === 'function' && !!require('uxp'); } catch (e) { return false; }
})();

// Show script errors in the panel itself, so a failure is never just "nothing works".
function showFatal(text) {
  let el = $('fatal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatal';
    el.className = 'notice notice-error';
    $('app').insertBefore(el, $('app').firstChild);
  }
  el.textContent = `Panel error: ${text}`;
}
window.addEventListener('error', (e) => showFatal(e.message || String(e.error)));

// Two panels share this one script: the main panel shows #app and the chat window
// (Editing Assistant Chat) shows #chat-app, so both use one helper connection and one state.
function attachTo(id) {
  return (arg) => {
    const node = arg && arg.node ? arg.node : arg;
    const el = $(id);
    if (node && node.appendChild && el && el.parentNode !== node) node.appendChild(el);
  };
}
if (IN_UXP) {
  try {
    require('uxp').entrypoints.setup({
      panels: {
        editingAssistantPanel: { create: attachTo('app'), show: attachTo('app') },
        editingAssistantChat: { create: attachTo('chat-app'), show: attachTo('chat-app') },
      },
    });
  } catch (e) { showFatal(e.message); }
} else {
  // Browser preview: index.html#chat shows the chat window, anything else the main panel.
  $(location.hash === '#chat' ? 'app' : 'chat-app').style.display = 'none';
}

// ---------- small UI helpers ----------
function hasClass(el, name) {
  return (' ' + (el.className || '') + ' ').indexOf(' ' + name + ' ') >= 0;
}
function setClass(el, name, on) {
  const parts = String(el.className || '').split(' ').filter((c) => c && c !== name);
  if (on) parts.push(name);
  el.className = parts.join(' ');
}
function each(selector, fn) {
  const list = document.querySelectorAll(selector);
  for (let i = 0; i < list.length; i++) fn(list[i]);
}
// Buttons are divs (full styling control in UXP), so "disabled" is a class.
function setDisabled(el, value) {
  setClass(el, 'is-disabled', !!value);
}
function onClick(el, fn) {
  el.addEventListener('click', (e) => {
    if (hasClass(el, 'is-disabled')) return;
    fn(e);
  });
}
// UXP doesn't restyle children when only a parent's class changes, so visibility
// is set inline on the element itself.
function show(el, visible) {
  setClass(el, 'hidden', !visible);
  el.style.display = visible ? '' : 'none';
}
function setSwitch(row, on) {
  setClass(row, 'on', on);
  setClass(row.querySelector('.switch'), 'switch-on', on);
  setClass(row.querySelector('.knob'), 'knob-on', on);
  row.querySelector('.knob').textContent = on ? '✓' : ''; // M3 switch handle shows a check when on
}
// Spectrum fields in Premiere can report null until edited, so reads fall back to the
// starting value and writes set both the property and the attribute.
function getValue(id) {
  const el = $(id);
  const v = el.value;
  return v === null || v === undefined ? (el.getAttribute('value') || '') : String(v);
}
function setValue(id, value) {
  const el = $(id);
  el.value = value;
  el.setAttribute('value', value);
}
function isOn(id) {
  return hasClass($(id), 'on');
}
function setMeta(id, text, tone) {
  const el = $(id);
  el.textContent = text;
  el.className = `panel-meta${tone ? ' meta-' + tone : ''}`;
}
function mmss(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
}
function recall(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v === null || v === undefined ? fallback : v;
  } catch (e) { return fallback; }
}

// Premiere's plain native inputs have no inner padding (CSS padding shrinks the box and
// clips the text), so inside Premiere swap them for the built-in Spectrum fields, which
// have proper spacing. Runs before any element lookups.
function useSpectrumFields() {
  each('.input', (old) => {
    const isArea = old.tagName === 'TEXTAREA';
    const field = document.createElement(isArea ? 'sp-textarea' : 'sp-textfield');
    field.id = old.id;
    field.className = isArea ? `sp-input sp-area ${old.className.replace(/\binput\b/, '')}` : 'sp-input';
    if (old.getAttribute('placeholder')) field.setAttribute('placeholder', old.getAttribute('placeholder'));
    field.setAttribute('quiet', ''); // no box of its own: it sits on the filled container
    old.parentElement.replaceChild(field, old);
    if (old.value) { field.setAttribute('value', old.value); field.value = old.value; }
  });
  each('.field-box, .composer, .select', (box) => setClass(box, 'native-ui', true));
  // With the composer's frame gone, the Send row needs its own gap from the text field.
  // Inline, because Premiere ignored the stylesheet padding here.
  each('.composer-row', (row) => {
    setClass(row, 'composer-row-native', true);
    row.style.marginTop = '10px';
  });
  each('.sp-area', (area) => { area.style.height = hasClass(area, 'handoff-text') ? '140px' : '56px'; });
}
if (IN_UXP) {
  try { useSpectrumFields(); } catch (e) { showFatal(e.message); }
}

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
let busy = false;           // some chat is answering
let busyChatId = null;      // which one
let currentChatId = recall('ea-chat', null); // the chat shown in the chat window
let chatsList = [];         // [{ id, title, updatedAt, count }] newest first
let jobBusy = false;        // a Premiere job (auto-cut, QA) is running in the helper
let currentReply = null;    // the assistant message being streamed into
const messageHooks = [];    // features.js handlers: return true when a message was theirs
const controlHooks = [];    // features.js: refresh enabled/disabled state
const connectHooks = [];    // features.js: run when the helper connects

function request(type, extra = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type, id: nextId++, ...extra }));
  return true;
}

// ---------- collapsible panels ----------
function saveOpenPanels() {
  const open = [];
  each('.panel', (p) => { if (hasClass(p, 'open')) open.push(p.getAttribute('data-panel')); });
  store(STORE_KEY, open);
}
function setPanelOpen(panel, open) {
  setClass(panel, 'open', open);
  const head = panel.querySelector('.panel-head');
  setClass(head, 'panel-head-open', open);
  setClass(head.querySelector('.tri'), 'tri-open', open);
  panel.querySelector('.panel-body').style.display = open ? 'block' : 'none';
}
function initPanels() {
  const saved = recall(STORE_KEY, null);
  const initiallyOpen = Array.isArray(saved) ? saved : ['clients', 'autocut', 'chat'];
  each('.panel', (panel) => {
    setPanelOpen(panel, initiallyOpen.indexOf(panel.getAttribute('data-panel')) >= 0);
    panel.querySelector('.panel-head').addEventListener('click', () => {
      setPanelOpen(panel, !hasClass(panel, 'open'));
      saveOpenPanels();
    });
  });
}

// ---------- connection ----------
function setConnection(isOnline) {
  online = isOnline;
  $('conn-text').textContent = isOnline ? 'Connected' : 'Offline';
  $('conn').firstElementChild.className = `dot ${isOnline ? 'dot-on' : 'dot-off'}`;
  show($('start-area'), !isOnline && IN_UXP);
  if (isOnline) $('start-status').textContent = '';
  if (!isOnline) {
    jobBusy = false;
    setBusy(false);
    checksEl.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'check-empty';
    li.textContent = IN_UXP
      ? 'The helper is not running. Press Start helper above. Retrying…'
      : 'The helper is not running. Start it with npm start in the helper folder. Retrying…';
    checksEl.appendChild(li);
    setMeta('setup-meta', 'Helper offline', 'bad');
  }
  updateControls();
}

function updateControls() {
  acUpdateControls();
  setDisabled(refreshBtn, !online);
  if ($('usage-check').textContent !== 'Checking…') setDisabled($('usage-check'), !online);
  setDisabled(sendBtn, !online || busy || !currentChatId);
  setDisabled(newChatBtn, !online);
  show(stopBtn, busy && busyChatId === currentChatId);
  for (const h of controlHooks) h();
}

// Only one chat answers at a time; busyChatId says which (null when Claude is idle).
function setBusyChat(id) {
  busyChatId = id || null;
  busy = !!busyChatId;
  if (!busy || busyChatId !== currentChatId) activityEl.textContent = '';
  if (busy) setMeta('chat-meta', 'Replying…', 'busy');
  else setMeta('chat-meta', ...chatIdleMeta());
  renderChatList();
  updateControls();
}
function setBusy(value) {
  setBusyChat(value ? busyChatId || currentChatId : null);
}

// Opens helper/start-helper.cmd (next to the panel folder) in a console window. Premiere can
// refuse or silently ignore the request, so the panel always says what to do if nothing connects.
async function startHelper() {
  const status = $('start-status');
  let script = 'helper\\start-helper.cmd in the Editing Assistant folder';
  status.textContent = 'Starting the helper…';
  try {
    const uxp = require('uxp');
    const folder = await uxp.storage.localFileSystem.getPluginFolder();
    const sep = folder.nativePath.indexOf('\\') >= 0 ? '\\' : '/';
    const parent = folder.nativePath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');
    script = `${parent}${sep}helper${sep}start-helper.cmd`;
    const result = await uxp.shell.openPath(script, 'Starts the Editing Assistant helper so the panel can connect.');
    if (result) {
      status.textContent = `Premiere couldn't open it (${result}). Double-click ${script} instead.`;
      return;
    }
  } catch (e) {
    status.textContent = `Premiere couldn't open it (${e.message}). Double-click ${script} instead.`;
    return;
  }
  setTimeout(() => {
    if (!online) status.textContent = `Still offline. If no helper window opened, double-click ${script}. Running install-autostart.cmd there once makes it start by itself at login.`;
  }, 8000);
}

// ---------- setup checklist ----------
const DOT = { ok: 'dot-on', warn: 'dot-warn', missing: 'dot-off' };

function checkRow(state, titleText, detailText) {
  const li = document.createElement('li');
  li.className = 'check';
  const dot = document.createElement('span');
  dot.className = `dot ${DOT[state] || ''}`;
  const body = document.createElement('div');
  body.className = 'check-body';
  const title = document.createElement('div');
  title.className = 'check-title';
  title.textContent = titleText;
  body.appendChild(title);
  if (detailText) {
    const detail = document.createElement('div');
    detail.className = 'check-detail';
    detail.textContent = detailText;
    body.appendChild(detail);
  }
  li.appendChild(dot);
  li.appendChild(body);
  return li;
}

function renderChecks(status) {
  checksEl.innerHTML = '';
  for (const c of status.checks) checksEl.appendChild(checkRow(c.state, c.label, c.detail));
  const missing = status.checks.filter((c) => c.state === 'missing').length;
  const warn = status.checks.filter((c) => c.state === 'warn').length;
  if (missing) setMeta('setup-meta', `${missing} missing`, 'bad');
  else if (warn) setMeta('setup-meta', `${warn} to check`, 'warn');
  else setMeta('setup-meta', 'All ready', 'ok');
  checkedAtEl.textContent = `Checked ${new Date(status.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function showChecking() {
  checksEl.innerHTML = '<li class="check-empty">Checking…</li>';
  setMeta('setup-meta', 'Checking…');
}

// ---------- usage meter ----------
function formatReset(epochSeconds) {
  if (!epochSeconds) return '';
  const d = new Date(epochSeconds * 1000);
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  if (mins <= 0) return 'now';
  const when = mins < 24 * 60
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const left = mins < 60 ? `${mins} min` : mins < 24 * 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${Math.floor(mins / 1440)} d ${Math.floor((mins % 1440) / 60)} h`;
  return `${when} (in ${left})`;
}

// Saved numbers can be old: once a window's reset time has passed, it is back to 0%.
function usedNow(window) {
  if (!window) return null;
  return window.resetsAt && window.resetsAt * 1000 <= Date.now() ? 0 : window.used;
}

function setMeter(prefix, window) {
  const used = usedNow(window);
  const pct = used === null ? 0 : Math.round(used * 100);
  $(`${prefix}-text`).textContent = used === null ? 'n/a' : `${pct}%`;
  const fill = $(`${prefix}-fill`);
  fill.style.width = `${Math.min(100, pct)}%`;
  fill.className = `bar-fill ${pct >= 90 ? 'bar-red' : pct >= 70 ? 'bar-amber' : 'bar-green'}`;
}

let lastUsage = null;

function chatIdleMeta() {
  const used = lastUsage && usedNow(lastUsage.fiveHour);
  if (used === null || used === undefined) return ['Claude Code', ''];
  const pct = Math.round(used * 100);
  return [`5-hour ${pct}% used`, pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : ''];
}

function renderUsage(usage) {
  lastUsage = usage;
  setMeter('u5', usage.fiveHour);
  setMeter('u7', usage.sevenDay);
  const five = usage.fiveHour;
  const reset = five && (usedNow(five) === 0 && five.used > 0 ? 'has reset' : `resets ${formatReset(five.resetsAt)}`);
  const checked = new Date(usage.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('usage-reset').textContent = `${reset ? `5-hour ${reset}. ` : ''}Checked ${checked}.`;
  const pct = (w) => (usedNow(w) === null ? 'n/a' : `${Math.round(usedNow(w) * 100)}%`);
  $('usage-summary').textContent = `Claude usage: 5-hour ${pct(usage.fiveHour)}, weekly ${pct(usage.sevenDay)} (checked ${checked}).`;
  if (!busy) setMeta('chat-meta', ...chatIdleMeta());
  const fivePct = usedNow(five) === null ? null : Math.round(usedNow(five) * 100);
  const chip = $('quota-chip');
  chip.textContent = fivePct === null ? 'Claude —' : `Claude ${fivePct}%`;
  chip.className = `quota${fivePct >= 90 ? ' quota-bad' : fivePct >= 70 ? ' quota-warn' : ''}`;
}

// ---------- chat ----------
// Claude's messages render as Markdown under a small "Claude" label (shown once per run of
// replies); returns the element text goes into, so streamed replies can keep appending.
function addMessage(kind, text) {
  const empty = messagesEl.querySelector('.empty');
  if (empty) messagesEl.removeChild(empty);
  const div = document.createElement('div');
  div.className = `msg msg-${kind}`;
  if (kind !== 'assistant') {
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }
  const prev = messagesEl.lastChild;
  if (!prev || !hasClass(prev, 'msg-assistant')) {
    const role = document.createElement('div');
    role.className = 'msg-role';
    role.textContent = 'Claude';
    div.appendChild(role);
  }
  const body = document.createElement('div');
  body.className = 'msg-body';
  div.appendChild(body);
  messagesEl.appendChild(div);
  setReplyText(body, text);
  return body;
}

// Streaming sends many small deltas; re-rendering the whole reply on each one gets slow on long
// replies, so redraws are batched to at most one every 50 ms (and flushed when the reply ends).
let renderTimer = null;
let renderTarget = null;
function drawReply(body) {
  body.innerHTML = '';
  body.appendChild(renderMarkdown(body.mdRaw));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function flushReply() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = null;
  if (renderTarget) drawReply(renderTarget);
  renderTarget = null;
}
function setReplyText(body, text) {
  if (body.mdRaw === text) return;
  body.mdRaw = text;
  if (renderTarget && renderTarget !== body) flushReply();
  renderTarget = body;
  if (!renderTimer) renderTimer = setTimeout(flushReply, 50);
}

// Check asks the helper for fresh numbers (one tiny request on Claude's cheapest model).
function setUsageChecking(on) {
  const btn = $('usage-check');
  btn.textContent = on ? 'Checking…' : 'Check';
  setDisabled(btn, on || !online);
}

let usageWarnedFor = null; // the reset time of the window already warned about

function sendPrompt() {
  const text = getValue('prompt').trim();
  if (!text || busy || !online) return;
  const five = lastUsage && lastUsage.fiveHour;
  if (five && usedNow(five) >= USAGE_WARN && usageWarnedFor !== five.resetsAt) {
    usageWarnedFor = five.resetsAt;
    addMessage('note', `You've used ${Math.round(usedNow(five) * 100)}% of your 5-hour limit (resets ${formatReset(five.resetsAt)}). Long tasks may hit the limit. Press Send again to go ahead.`);
    return;
  }
  if (!currentChatId) return;
  if (request('chat-send', { chatId: currentChatId, text })) {
    setValue('prompt', '');
    setBusyChat(currentChatId);
    activityEl.textContent = 'Thinking…';
  }
}

// ---------- chat list ----------
const EMPTY_CHAT = 'Ask about your project, the timeline, or anything else. Claude can read Premiere; edits come later.';

function whenText(t) {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderChatList() {
  const box = $('chat-list-items');
  if (!box) return;
  box.innerHTML = '';
  for (const c of chatsList) {
    const row = document.createElement('div');
    row.className = `chat-row${c.id === currentChatId ? ' chat-row-current' : ''}`;
    const title = document.createElement('div');
    title.className = 'chat-row-title';
    title.textContent = c.title;
    const meta = document.createElement('div');
    meta.className = 'chat-row-meta';
    meta.textContent = c.id === busyChatId ? 'Replying…' : whenText(c.updatedAt);
    if (c.id === busyChatId) setClass(meta, 'meta-busy', true);
    row.appendChild(title);
    row.appendChild(meta);
    row.addEventListener('click', () => {
      showChatList(false);
      if (c.id !== currentChatId) request('chat-open', { chatId: c.id });
    });
    box.appendChild(row);
  }
  if (!chatsList.length) {
    const none = document.createElement('div');
    none.className = 'hint';
    none.textContent = 'No chats yet.';
    box.appendChild(none);
  }
}

function showChatList(open) {
  show($('chat-list'), open);
  show($('usage-pop'), false);
  if (open) {
    const cur = chatsList.find((c) => c.id === currentChatId);
    setValue('chat-rename', cur ? cur.title : '');
    renderChatList();
  }
}

let loadedChatId = null; // the chat whose messages are on screen

function openChat(chat, isBusy) {
  currentChatId = chat.id;
  loadedChatId = chat.id;
  store('ea-chat', chat.id);
  $('chat-title').textContent = chat.title;
  currentReply = null;
  messagesEl.innerHTML = '';
  if (!chat.messages.length) messagesEl.innerHTML = `<div class="empty">${EMPTY_CHAT}</div>`;
  for (const m of chat.messages) {
    addMessage(m.kind === 'approval' ? 'note' : m.kind, m.text); // old chats can hold approval cards
  }
  // Text arriving for a reply that's already streaming continues its last message.
  if (isBusy && chat.messages.length && chat.messages[chat.messages.length - 1].kind === 'assistant') {
    currentReply = messagesEl.lastChild && messagesEl.lastChild.querySelector('.msg-body');
  }
  flushReply();
  activityEl.textContent = isBusy ? 'Replying…' : '';
  renderChatList();
  updateControls();
}

// After the list changes: keep the current chat, or fall back to the newest (or a new one).
function syncCurrentChat() {
  if (currentChatId && chatsList.some((c) => c.id === currentChatId)) {
    const cur = chatsList.find((c) => c.id === currentChatId);
    $('chat-title').textContent = cur.title;
    if (loadedChatId !== currentChatId) request('chat-open', { chatId: currentChatId });
    return;
  }
  if (chatsList.length) request('chat-open', { chatId: chatsList[0].id });
  else request('chat-create');
}

let deleteArmed = null; // Delete chat asks for a second click within 3 seconds
function deleteCurrentChat() {
  const btn = $('chat-delete');
  if (deleteArmed !== currentChatId) {
    deleteArmed = currentChatId;
    btn.textContent = 'Click again to delete';
    setTimeout(() => { deleteArmed = null; btn.textContent = 'Delete chat'; }, 3000);
    return;
  }
  deleteArmed = null;
  btn.textContent = 'Delete chat';
  request('chat-delete', { chatId: currentChatId });
  currentChatId = null;
  showChatList(false);
}

// ---------- Premiere safety check ----------
let recoveryInfo = null;

function showRecovery(text, canContinue) {
  show($('recovery'), true);
  $('recovery-text').textContent = text;
  show($('recovery-ack'), canContinue);
  show($('recovery-check'), !canContinue);
}

function handleRecovery(msg) {
  if (msg.type !== 'recovery') return false;
  if (msg.cleared || !msg.required) {
    recoveryInfo = null;
    show($('recovery'), false);
    if (msg.cleared) showAcNotice('Safety check done. Premiere accepts edits again; try the last step again.');
    return true;
  }
  recoveryInfo = msg;
  showRecovery(`${msg.reason} Premiere's active sequence has ${msg.clipCount} clip${msg.clipCount === 1 ? '' : 's'} in the checked range. If the timeline looks right, press Continue.`, true);
  return true;
}

function handleChatEvent(msg) {
  if (msg.type !== 'chat-delta') flushReply(); // anything but more text: show the reply so far
  switch (msg.type) {
    case 'chat-user':
      addMessage('user', msg.text);
      currentReply = null;
      setBusyChat(msg.chatId || currentChatId);
      break;
    case 'chat-block':
      // A new text block starts after tool use; keep one message per block.
      if (currentReply && currentReply.mdRaw) currentReply = null;
      break;
    case 'chat-delta':
      if (!currentReply) currentReply = addMessage('assistant', '');
      setReplyText(currentReply, (currentReply.mdRaw || '') + msg.text);
      activityEl.textContent = 'Replying…';
      break;
    case 'chat-tool':
      activityEl.textContent = `Using ${msg.name}${msg.input ? ': ' + msg.input : ''}`;
      currentReply = null;
      break;
    case 'chat-done':
      if (msg.isError) addMessage('error', msg.error || 'Claude reported an error.');
      currentReply = null;
      setBusyChat(null);
      break;
    case 'chat-error':
      addMessage('error', msg.error);
      currentReply = null;
      setBusyChat(null);
      break;
    default:
      break;
  }
}

// Shows the chat window: Premiere's panel API where it has one, a second window in the preview.
function openChatWindow() {
  if (!IN_UXP) {
    window.open('index.html#chat', 'ea-chat', 'width=440,height=680');
    return;
  }
  try {
    const panel = require('uxp').entrypoints.getPanel('editingAssistantChat');
    panel.show();
  } catch (e) {
    setMeta('chat-meta', 'Window › UXP Plugins › Editing Assistant Chat', 'warn');
  }
}

function handleMessage(msg) {
  if (handleRecovery(msg)) return;
  if (msg.recovery && /-error$/.test(msg.type)) showRecovery('Premiere wants a safety check before more edits.', false);
  for (const h of messageHooks) if (h(msg)) return;
  if (handleAutocut(msg)) return;
  switch (msg.type) {
    case 'hello':
      jobBusy = !!msg.jobBusy;
      setBusyChat(msg.busyChatId);
      // The helper remembers the last auto-cut across restarts, so it can still be undone.
      if (msg.undo && hasClass($('ac-results'), 'hidden')) {
        showAcNotice(`The last auto-cut on "${msg.undo.of}" can still be undone (backup: "${msg.undo.backup}").`);
        show($('ac-after'), true);
      }
      break;
    case 'chats':
      chatsList = msg.chats || [];
      setBusyChat(msg.busyChatId);
      syncCurrentChat();
      break;
    case 'chat-opened':
      openChat(msg.chat, msg.busy);
      break;
    case 'job-busy':
      jobBusy = msg.busy;
      updateControls();
      break;
    case 'status':
      renderChecks(msg);
      break;
    case 'usage':
      renderUsage(msg.usage);
      setUsageChecking(false);
      break;
    case 'usage-error':
      setUsageChecking(false);
      $('usage-reset').textContent = `Couldn't check usage: ${msg.error}`;
      break;
    // Chat events carry their chat; only the chat on screen draws them (the helper stores all).
    case 'chat-user':
    case 'chat-block':
    case 'chat-delta':
    case 'chat-tool':
    case 'chat-done':
    case 'chat-error':
      if (msg.chatId && msg.chatId !== currentChatId) {
        if (msg.type === 'chat-done' || msg.type === 'chat-error') setBusyChat(null);
        break;
      }
      handleChatEvent(msg);
      break;
    case 'error':
      console.error('Helper error:', msg.error);
      if (msg.request === 'seek') setMeta('ac-meta', "Couldn't move the playhead", 'warn');
      break;
    default:
      break;
  }
}

// ---------- auto-cut ----------
const acAnalyzeBtn = $('ac-analyze');
const acApplyBtn = $('ac-apply');
const acMarkersBtn = $('ac-markers');
const acClearBtn = $('ac-clear-markers');
const acUndoBtn = $('ac-undo');
const acStopBtn = $('ac-stop');
let acBusy = false;
let acCutCount = 0;
let acAppliedRanges = []; // cuts already made, so review times can follow the shortened timeline

// A time from the analysis, moved to where it sits after the applied cuts.
function afterCuts(t) {
  let shift = 0;
  for (const [s, e] of acAppliedRanges) if (s < t) shift += Math.min(e, t) - s;
  return Math.max(0, t - shift);
}

function seekTo(t) {
  request('seek', { t: afterCuts(t) });
}

function acSettings() {
  const thr = getValue('ac-threshold').trim();
  return {
    pauseSeconds: Number(getValue('ac-pause')) || 0.5,
    track: Number($('ac-track').value) || 0,
    thresholdDb: thr === '' ? 'auto' : Number(thr),
    removeRetakes: isOn('ac-retakes'),
    removeUms: isOn('ac-ums'),
    slatePhrases: getValue('ac-slates').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

function acUpdateControls() {
  const blocked = !online || jobBusy;
  setDisabled(acAnalyzeBtn, blocked);
  setDisabled(acApplyBtn, blocked);
  setDisabled(acMarkersBtn, blocked);
  setDisabled(acClearBtn, blocked);
  setDisabled(acUndoBtn, blocked);
  show(acStopBtn, acBusy);
  acAnalyzeBtn.textContent = acBusy ? 'Working…' : 'Analyze';
}

// Rows of [time, text]; the time is clickable and moves the Premiere playhead there.
function listBlock(title, rows, note) {
  const wrap = document.createElement('div');
  wrap.className = 'list';
  const h = document.createElement('div');
  h.className = 'list-title';
  h.textContent = title;
  wrap.appendChild(h);
  if (note) {
    const n = document.createElement('div');
    n.className = 'hint list-note';
    n.textContent = note;
    wrap.appendChild(n);
  }
  const frag = document.createDocumentFragment();
  for (const [time, text] of rows) {
    const row = document.createElement('div');
    row.className = 'list-row list-row-link';
    const t = document.createElement('span');
    t.className = 'list-time';
    t.textContent = mmss(afterCuts(time));
    const x = document.createElement('span');
    x.className = 'list-text';
    x.textContent = text;
    row.appendChild(t);
    row.appendChild(x);
    row.addEventListener('click', () => { if (online && !jobBusy) seekTo(time); });
    frag.appendChild(row);
  }
  wrap.appendChild(frag);
  return wrap;
}

function chip(text) {
  const c = document.createElement('span');
  c.className = 'chip';
  c.textContent = text;
  return c;
}

let acReviewRows = null; // kept so the lists can be redrawn with post-cut times

function renderReviewLists() {
  const lists = $('ac-lists');
  lists.innerHTML = '';
  if (!acReviewRows) return;
  if (acReviewRows.review.length) lists.appendChild(listBlock('Check after applying', acReviewRows.review, 'Click a time to jump there in Premiere.'));
  if (acReviewRows.retakes.length) lists.appendChild(listBlock('Retakes removed', acReviewRows.retakes));
}

function setMarkersPlaced(placed) {
  show($('ac-marker-note'), placed);
  show(acClearBtn, placed);
  acMarkersBtn.textContent = placed ? 'Markers placed' : 'Preview as markers';
  acApplyBtn.textContent = placed ? 'Apply cuts with markers left' : `Apply ${acCutCount} cuts`;
}

function renderAnalysis(r) {
  acAppliedRanges = [];
  show($('ac-results'), true);
  show($('ac-done'), false);
  show($('ac-after'), false);
  setMeta('ac-meta', r.sequence.name);
  const st = r.stats;
  acCutCount = st.cuts;
  $('ac-count').textContent = String(st.cuts);
  $('ac-durations').textContent = st.cuts
    ? `${mmss(st.before)} to ${mmss(st.after)}, saves ${mmss(st.removedSeconds)}`
    : 'Nothing to cut with these settings.';

  const chips = $('ac-chips');
  chips.innerHTML = '';
  chips.appendChild(chip(`${st.retakes} retakes`));
  chips.appendChild(chip(`${st.ums} ums/breaths`));
  chips.appendChild(chip(`${st.pauses} pauses`));
  chips.appendChild(chip(`${r.threshold} dB`));

  const review = [];
  for (const x of r.review.unconfidentRetakes) review.push([x.at, `Unsure retake: "${x.removedText}"`]);
  for (const x of r.review.longUnworded) review.push([x.at, `${x.seconds}s sound cut as an um, check it isn't a word`]);
  for (const x of r.review.repeats) review.push([x.at, `Possible repeat, not cut: "${x.text}"`]);
  review.sort((a, b) => a[0] - b[0]);
  acReviewRows = { review, retakes: r.retakes.map((x) => [x.at, `"${x.removedText}"`]) };
  renderReviewLists();

  show($('ac-apply-area'), st.cuts > 0);
  setMarkersPlaced(false);
}

function setAcProgress(label, done, total) {
  show($('ac-working'), !!label);
  $('ac-progress').textContent = label || '';
  const bar = $('ac-bar');
  show(bar.parentElement, !!total);
  if (total) bar.style.width = `${Math.round((done / total) * 100)}%`;
}

function showAcNotice(text, isError) {
  const el = $('ac-done');
  el.className = `notice${isError ? ' notice-error' : ''}`;
  el.style.display = '';
  el.textContent = text;
}

function handleAutocut(msg) {
  switch (msg.type) {
    case 'autocut-busy':
      acBusy = msg.busy;
      setDisabled(acStopBtn, false);
      acUpdateControls();
      if (msg.busy) setMeta('ac-meta', 'Working…', 'busy');
      else if ($('ac-meta').textContent === 'Working…') setMeta('ac-meta', 'Active sequence');
      if (!msg.busy && $('ac-progress').textContent === 'Starting…') setAcProgress('');
      return true;
    case 'autocut-progress':
      setAcProgress(msg.label, msg.done, msg.total);
      return true;
    case 'autocut-result':
      setAcProgress('');
      renderAnalysis(msg.result);
      return true;
    case 'autocut-markers':
      setAcProgress('');
      setMarkersPlaced(msg.placed);
      return true;
    case 'autocut-applied': {
      const r = msg.result;
      setAcProgress('');
      show($('ac-results'), false);
      acAppliedRanges = r.ranges || [];
      renderReviewLists();
      if (r.stopped) {
        showAcNotice(`Stopped after ${r.applied} cuts${r.durationAfter ? `, now ${mmss(r.durationAfter)}` : ''}. Undo cuts puts the sequence back to how it was.`);
        show($('ac-after'), true);
        setMeta('ac-meta', 'Stopped', 'warn');
        return true;
      }
      if (!r.applied) {
        showAcNotice(r.skipped ? `No cuts made: all ${r.skipped} markers were removed.` : 'Nothing to cut.');
        return true;
      }
      const kept = r.skipped ? ` ${r.skipped} kept because you removed their markers.` : '';
      showAcNotice(`Done: ${r.applied} cuts applied.${kept} ${r.durationAfter ? `Now ${mmss(r.durationAfter)}. ` : ''}Backup: "${r.backup.name}".`);
      show($('ac-after'), true);
      setMeta('ac-meta', `${r.applied} cuts applied`, 'ok');
      return true;
    }
    case 'autocut-stopped':
      setAcProgress('');
      showAcNotice(msg.kind === 'placing cut markers' ? 'Stopped. Some markers may already be on the timeline; Clear markers removes them.' : 'Stopped. Nothing on the timeline was changed.');
      setMeta('ac-meta', 'Stopped', 'warn');
      return true;
    case 'autocut-undone': {
      const r = msg.result;
      acAppliedRanges = [];
      acReviewRows = null;
      renderReviewLists();
      show($('ac-after'), false);
      showAcNotice(`Undone: "${r.restored}" is back to how it was before Apply.${r.keptAs ? ` The cut version is kept as "${r.keptAs}".` : ''}`);
      setMeta('ac-meta', 'Cuts undone', 'ok');
      return true;
    }
    case 'autocut-error':
      setAcProgress('');
      showAcNotice(msg.error, true);
      setMeta('ac-meta', 'Error', 'bad');
      return true;
    default:
      return false;
  }
}

// ---------- wiring ----------
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
    showChecking();
    request('status');
    for (const h of connectHooks) h();
  };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    try { handleMessage(msg); } catch (e) { showFatal(e.message); }
  };
  ws.onclose = () => {
    loadedChatId = null; // reload the chat's messages on reconnect
    setConnection(false);
    setTimeout(connect, RECONNECT_MS);
  };
  ws.onerror = () => { /* onclose follows and handles the retry */ };
}

// Switch rows flip on click; their state is read with isOn().
function wireSwitches() {
  each('.switch-row', (row) => {
    setSwitch(row, hasClass(row, 'on'));
    row.addEventListener('click', () => setSwitch(row, !hasClass(row, 'on')));
  });
}

function wire() {
  initPanels();
  wireSwitches();

  $('ac-more-toggle').addEventListener('click', () => {
    const more = $('ac-more');
    const opening = hasClass(more, 'hidden');
    show(more, opening);
    setClass($('ac-more-tri'), 'tri-open', opening);
  });

  onClick(acAnalyzeBtn, () => {
    show($('ac-results'), false);
    show($('ac-done'), false);
    show($('ac-after'), false);
    setAcProgress('Starting…');
    request('autocut-analyze', { settings: acSettings() });
  });
  onClick(acMarkersBtn, () => {
    setAcProgress('Placing markers…');
    request('autocut-markers');
  });
  onClick(acClearBtn, () => request('autocut-clear-markers'));
  onClick(acApplyBtn, () => {
    setAcProgress('Starting…', 0, 1);
    request('autocut-apply');
  });
  onClick(acUndoBtn, () => request('autocut-undo'));
  onClick(acStopBtn, () => {
    setDisabled(acStopBtn, true);
    request('autocut-stop');
  });

  onClick($('recovery-check'), () => request('recovery-check'));
  onClick($('recovery-ack'), () => {
    if (recoveryInfo) request('recovery-ack', { recoveryRevision: recoveryInfo.recoveryRevision, hostStateRevision: recoveryInfo.hostStateRevision });
  });
  onClick($('usage-check'), () => {
    setUsageChecking(true);
    if (!request('usage-check')) setUsageChecking(false);
  });
  onClick(refreshBtn, () => {
    showChecking();
    request('status');
  });
  onClick($('start-helper'), () => startHelper().catch((e) => showFatal(e.message)));
  onClick(sendBtn, sendPrompt);
  onClick(stopBtn, () => request('chat-stop'));
  onClick(newChatBtn, () => {
    showChatList(false);
    request('chat-create');
  });
  $('chat-picker').addEventListener('click', () => showChatList(hasClass($('chat-list'), 'hidden')));
  onClick($('chat-rename-save'), () => {
    const title = getValue('chat-rename').trim();
    if (title && currentChatId) request('chat-rename', { chatId: currentChatId, title });
    showChatList(false);
  });
  onClick($('chat-delete'), deleteCurrentChat);
  onClick($('open-chat'), openChatWindow);
  $('quota-chip').addEventListener('click', () => {
    const opening = hasClass($('usage-pop'), 'hidden');
    showChatList(false);
    show($('usage-pop'), opening);
  });
  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });
  if (!IN_UXP) {
    // Focus ring goes on the wrapping box (the composer or a .field-box).
    each('.input', (input) => {
      input.addEventListener('focus', () => setClass(input.parentElement, 'focused', true));
      input.addEventListener('blur', () => setClass(input.parentElement, 'focused', false));
    });
  }
  // Keep the reset countdown current.
  setInterval(() => { if (lastUsage) renderUsage(lastUsage); }, 60000);
}

try {
  wire();
  setConnection(false);
} catch (e) {
  showFatal(e.message);
}
// connect() is called at the end of features.js, once its message hooks are registered.
