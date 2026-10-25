// Editing Assistant panel, part 2: client guides, captions and review (QA + handoff note).
// Loads after main.js and uses its helpers (request, show, setMeta, onClick, ...).
const CLIENT_KEY = 'ea-client';

let clientId = recall(CLIENT_KEY, '');
let clientName = '';

// ---------- client guide ----------
// A small Markdown renderer for the knowledge base's client pages: headings, nested bullets,
// **bold**, `code` and [links] (shown as text). Builds DOM nodes, never innerHTML.
function inlineNodes(text) {
  const frag = document.createDocumentFragment();
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]+\)|\*([^*]+)\*/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const span = document.createElement('span');
    if (m[1]) { span.className = 'md-bold'; span.textContent = m[1]; }
    else if (m[2]) { span.className = 'md-code'; span.textContent = m[2]; }
    else if (m[3]) { span.className = 'md-link'; span.textContent = m[3]; }
    else { span.className = 'md-dim'; span.textContent = m[4]; }
    frag.appendChild(span);
    last = re.lastIndex;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function renderGuide(markdown) {
  const box = $('client-guide');
  box.innerHTML = '';
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^#\s/.test(line)) continue; // the title is already in the picker
    // The same onboarding boilerplate opens every page; skip it so client rules come first.
    if (/^\*Copied from/.test(line) || /^\*\*Shared layout/.test(line)) continue;
    let el;
    const h = line.match(/^#{2,4}\s+(.+)$/);
    const li = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (h) {
      el = document.createElement('div');
      el.className = 'md-h';
      el.textContent = h[1];
    } else if (li) {
      el = document.createElement('div');
      el.className = li[1].length >= 2 ? 'md-li md-li-2' : 'md-li';
      const bullet = document.createElement('span');
      bullet.className = 'md-bullet';
      bullet.textContent = li[1].length >= 2 ? '–' : '•';
      const text = document.createElement('span');
      text.className = 'md-li-text';
      text.appendChild(inlineNodes(li[2]));
      el.appendChild(bullet);
      el.appendChild(text);
    } else {
      el = document.createElement('div');
      el.className = /^\*[^*]/.test(line) ? 'md-p md-note' : 'md-p';
      el.appendChild(inlineNodes(line));
    }
    box.appendChild(el);
  }
  show(box, true);
  show($('client-empty'), false);
}

function fillClientPicker(clients) {
  const select = $('client-select');
  while (select.options.length > 1) select.removeChild(select.options[1]);
  for (const c of clients) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  }
  if (clientId && clients.some((c) => c.id === clientId)) {
    select.value = clientId;
    request('client-get', { client: clientId });
  } else if (!clients.length) {
    $('client-empty').textContent = 'No client guides found. They are read from knowledge-base/clients.';
  }
}

function chooseClient(id) {
  clientId = id;
  store(CLIENT_KEY, id);
  if (!id) {
    clientName = '';
    setMeta('client-meta', 'None chosen');
    show($('client-guide'), false);
    show($('client-empty'), true);
    $('cap-words-hint').textContent = "Set from the client's guide when it has a words-per-line rule.";
    return;
  }
  setMeta('client-meta', 'Loading…');
  request('client-get', { client: id });
}

function applyClient(c) {
  if (c.id !== clientId) return; // a slower reply for a client no longer chosen
  clientName = c.name;
  setMeta('client-meta', c.name, 'ok');
  renderGuide(c.markdown);
  if (c.hints && c.hints.wordsPerCue) {
    $('cap-words').value = String(c.hints.wordsPerCue);
    $('cap-words-hint').textContent = `${c.name}'s guide: ${c.hints.wordsPerCue} words max per line.`;
  } else {
    $('cap-words-hint').textContent = `${c.name}'s guide has no words-per-line rule; using your setting.`;
  }
}

// ---------- captions ----------
function capOptions() {
  return {
    wordsPerCue: Math.max(1, Math.min(8, Math.round(Number($('cap-words').value) || 4))),
    uppercase: isOn('cap-upper'),
    stripPunctuation: isOn('cap-punct'),
  };
}

function capNotice(text, isError) {
  const el = $('cap-done');
  el.className = `notice${isError ? ' notice-error' : ''}`;
  el.style.display = '';
  el.textContent = text;
}

// ---------- review: QA + handoff ----------
function renderQa(r) {
  show($('qa-error'), false);
  show($('qa-results'), true);
  const list = $('qa-checks');
  list.innerHTML = '';
  for (const c of r.checks) {
    const row = checkRow(c.state, c.label, c.detail);
    if (c.times && c.times.length) {
      const body = row.querySelector('.check-body');
      for (const t of c.times) {
        const link = document.createElement('div');
        link.className = 'list-row list-row-link';
        const time = document.createElement('span');
        time.className = 'list-time';
        time.textContent = mmss(t.t);
        const text = document.createElement('span');
        text.className = 'list-text';
        text.textContent = t.text;
        link.appendChild(time);
        link.appendChild(text);
        // QA times are already on the current timeline: no cut mapping.
        link.addEventListener('click', () => { if (online && !jobBusy) request('seek', { t: t.t }); });
        body.appendChild(link);
      }
    }
    list.appendChild(row);
  }
  const issues = r.checks.filter((c) => c.state !== 'ok').length;
  setMeta('qa-meta', issues ? `${issues} to fix` : 'Checks passed', issues ? 'warn' : 'ok');

  const clientBox = $('qa-client');
  const items = $('qa-checklist');
  items.innerHTML = '';
  show(clientBox, !!(r.client && r.checklist.length));
  if (r.client) $('qa-client-title').textContent = `${r.client.name} must-dos`;
  for (const text of r.checklist) {
    const row = document.createElement('div');
    row.className = 'tick-row';
    const box = document.createElement('div');
    box.className = 'tick';
    const label = document.createElement('div');
    label.className = 'tick-text';
    label.appendChild(inlineNodes(text));
    row.appendChild(box);
    row.appendChild(label);
    row.addEventListener('click', () => {
      const on = !hasClass(row, 'done');
      setClass(row, 'done', on);
      setClass(box, 'tick-on', on);
      box.textContent = on ? '✓' : '';
      setClass(label, 'tick-text-done', on);
    });
    items.appendChild(row);
  }
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.setContent) return navigator.clipboard.setContent({ 'text/plain': text }); // UXP
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  throw new Error('Clipboard not available');
}

// ---------- messages from the helper ----------
messageHooks.push((msg) => {
  switch (msg.type) {
    case 'clients':
      fillClientPicker(msg.clients || []);
      return true;
    case 'client':
      applyClient(msg.client);
      return true;

    case 'captions-busy':
      setDisabled($('cap-make'), msg.busy || !online);
      $('cap-make').textContent = msg.busy ? 'Working…' : 'Make captions';
      setMeta('cap-meta', msg.busy ? 'Working…' : 'From the transcript', msg.busy ? 'busy' : '');
      if (!msg.busy) show($('cap-working'), false);
      return true;
    case 'captions-progress':
      show($('cap-working'), true);
      $('cap-progress').textContent = msg.label || '';
      return true;
    case 'captions-done': {
      const r = msg.result;
      capNotice(`Added ${r.cues} captions to "${r.sequence}". Starts: ${r.preview.join(' / ')}. Style them in Premiere (Essential Graphics) with the client's font. File: ${r.file}`);
      setMeta('cap-meta', `${r.cues} captions added`, 'ok');
      return true;
    }
    case 'captions-error':
      capNotice(msg.error, true);
      setMeta('cap-meta', 'Error', 'bad');
      return true;

    case 'qa-busy':
      show($('qa-working'), msg.busy);
      $('qa-run').textContent = msg.busy ? 'Checking…' : 'Run QA checks';
      if (msg.busy) setMeta('qa-meta', 'Checking…', 'busy');
      return true;
    case 'qa-result':
      renderQa(msg.result);
      return true;
    case 'qa-error': {
      const el = $('qa-error');
      el.textContent = msg.error;
      show(el, true);
      setMeta('qa-meta', 'Error', 'bad');
      return true;
    }
    case 'handoff-draft':
      $('handoff-text').value = msg.text;
      show($('handoff-out'), true);
      $('handoff-copied').textContent = 'Edit it here if you like, then copy. Nothing is posted.';
      return true;
    case 'error':
      if (msg.request === 'client-get') {
        setMeta('client-meta', 'Not found', 'bad');
        return true;
      }
      return false;
    default:
      return false;
  }
});

controlHooks.push(() => {
  const blocked = !online || jobBusy;
  setDisabled($('cap-make'), blocked);
  setDisabled($('qa-run'), blocked);
  setDisabled($('handoff-make'), !online);
  setDisabled($('handoff-copy'), false);
});

connectHooks.push(() => request('clients-list'));

// ---------- wiring ----------
$('client-select').addEventListener('change', () => chooseClient($('client-select').value));
onClick($('cap-make'), () => {
  show($('cap-done'), false);
  show($('cap-working'), true);
  $('cap-progress').textContent = 'Starting…';
  request('captions-make', { options: capOptions() });
});
onClick($('qa-run'), () => {
  show($('qa-error'), false);
  request('qa-run', { client: clientId || null });
});
onClick($('handoff-make'), () => request('handoff-draft', { client: clientId || null, note: $('handoff-extra').value }));
onClick($('handoff-copy'), () => {
  copyText($('handoff-text').value)
    .then(() => { $('handoff-copied').textContent = 'Copied. Paste it into ClickUp or Slack.'; })
    .catch(() => { $('handoff-copied').textContent = "Couldn't copy; select the text and press Ctrl+C."; });
});
updateControls();
connect();
