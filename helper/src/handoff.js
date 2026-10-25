// Internal-review handoff note, drafted from what happened in this session (auto-cut, QA).
// Text only: the editor copies it into ClickUp or Slack themselves; nothing is ever posted from here.
const mmss = (s) => {
  const t = Math.max(0, Math.round(s || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

export function draftHandoff({ clientName, qa, autocut, note }) {
  const seq = qa && qa.sequence;
  const lines = [];
  lines.push(`${clientName ? clientName + ': ' : ''}${seq ? `"${seq.name}"` : 'this edit'} is ready for internal review.`);
  lines.push('');
  if (seq && seq.duration) lines.push(`- Length: ${mmss(seq.duration)}`);
  if (autocut && autocut.applied) {
    lines.push(`- Cleaned up dialogue: ${autocut.applied} cuts (retakes, ums, long pauses)${autocut.durationBefore ? `, ${mmss(autocut.durationBefore)} to ${mmss(autocut.durationAfter || autocut.expectedAfter)}` : ''}.`);
  }
  if (qa) {
    const issues = qa.checks.filter((c) => c.state !== 'ok');
    lines.push(issues.length
      ? `- QA: ${issues.map((c) => c.label.toLowerCase()).join(', ')} still to look at.`
      : '- QA: no gaps, no offline media, no leftover markers.');
    if (qa.checklist && qa.checklist.length) lines.push(`- Checked against the ${clientName || 'client'} must-dos (${qa.checklist.length} items).`);
  }
  lines.push('- Review link: [add link]');
  if (note && note.trim()) {
    lines.push('');
    lines.push(note.trim());
  }
  return lines.join('\n');
}
