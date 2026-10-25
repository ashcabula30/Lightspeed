// Small Markdown renderer for Claude's chat replies and the client guides. Builds DOM nodes
// (never innerHTML), so nothing in a reply can inject markup. Covers what Claude actually writes:
// paragraphs, headings, bullet and numbered lists, ``` code blocks, rules, **bold**, *italic*,
// `code` and [links] (shown as text: UXP panels can't follow them).

// **bold**, __bold__, `code`, [text](url), *italic*, _italic_
function inlineNodes(text) {
  const frag = document.createDocumentFragment();
  const re = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\([^)]+\)|\*([^*\s][^*]*)\*|\b_([^_]+)_\b/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const span = document.createElement('span');
    if (m[1] || m[2]) { span.className = 'md-bold'; span.textContent = m[1] || m[2]; }
    else if (m[3]) { span.className = 'md-code'; span.textContent = m[3]; }
    else if (m[4]) { span.className = 'md-link'; span.textContent = m[4]; }
    else { span.className = 'md-dim'; span.textContent = m[5] || m[6]; }
    frag.appendChild(span);
    last = re.lastIndex;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function mdDiv(cls) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function renderMarkdown(text) {
  const out = document.createDocumentFragment();
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let para = [];   // lines of the paragraph being collected
  let list = null; // the list being collected
  let code = null; // lines of an open ``` block

  const flushPara = () => {
    if (!para.length) return;
    const p = mdDiv('md-block');
    p.appendChild(inlineNodes(para.join(' ')));
    out.appendChild(p);
    para = [];
  };
  const flushList = () => {
    if (list) out.appendChild(list);
    list = null;
  };

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) {
        const pre = mdDiv('md-pre');
        pre.textContent = code.join('\n');
        out.appendChild(pre);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { flushPara(); flushList(); code = []; continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }

    const h = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (h) {
      flushPara(); flushList();
      const el = mdDiv('md-heading');
      el.appendChild(inlineNodes(h[1]));
      out.appendChild(el);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); flushList(); out.appendChild(mdDiv('md-rule')); continue; }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
    if (li) {
      flushPara();
      if (!list) list = mdDiv('md-block md-ul');
      const row = mdDiv(li[1].length >= 2 ? 'md-li md-li-2' : 'md-li');
      const bullet = document.createElement('span');
      bullet.className = 'md-bullet';
      bullet.textContent = /\d/.test(li[2]) ? li[2] : '•';
      const body = document.createElement('span');
      body.className = 'md-li-text';
      body.appendChild(inlineNodes(li[3]));
      row.appendChild(bullet);
      row.appendChild(body);
      list.appendChild(row);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  if (code) { // an unfinished block while the reply is still streaming
    const pre = mdDiv('md-pre');
    pre.textContent = code.join('\n');
    out.appendChild(pre);
  }
  flushPara();
  flushList();
  return out;
}
