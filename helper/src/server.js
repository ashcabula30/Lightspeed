// Editing Assistant helper: a local WebSocket server the Premiere panel connects to.
// Listens on 127.0.0.1 only, so nothing outside this computer can reach it.
import { WebSocketServer } from 'ws';
import { runChecks } from './checks.js';
import { ClaudeChat } from './claude.js';
import { loadConfig } from './config.js';
import { call } from './premiere.js';
import { analyzeSequence } from './autocut/index.js';
import { applyCuts } from './autocut/apply.js';
import { clearCutMarkers, placeCutMarkers } from './autocut/markers.js';
import { makeCaptions } from './captions.js';
import { getClient, listClients } from './clients.js';
import { runQa } from './qa.js';
import { draftHandoff } from './handoff.js';

export const PORT = Number(process.env.EA_PORT || 7790);
const VERSION = '0.4.0';
const config = loadConfig();

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT, path: '/panel' });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  for (const ws of wss.clients) send(ws, msg);
}

// One conversation shared by every open panel, so reopening the panel keeps the chat going.
const chat = new ClaudeChat({ workdir: config.workdir, onEvent: broadcast });

// What this session has done, for Apply, Restore and the handoff draft.
const session = { analysis: null, applied: null, backup: null, captions: null, qa: null };

// Premiere jobs run one at a time (they share the active sequence, playhead and undo history).
let jobBusy = null;

async function runJob(kind, prefix, job) {
  if (jobBusy) throw new Error(`Busy with ${jobBusy}. Try again when it finishes.`);
  jobBusy = kind;
  broadcast({ type: 'job-busy', busy: true, kind });
  broadcast({ type: `${prefix}-busy`, busy: true, kind });
  try {
    await job();
  } catch (err) {
    console.error(`[helper] ${kind} failed:`, err);
    const hint = err.recovery ? ' Premiere asked for a safety check after an earlier failed command; ask in the chat to inspect and acknowledge the recovery, then try again.' : '';
    broadcast({ type: `${prefix}-error`, kind, error: `${err.message}${hint}` });
  } finally {
    jobBusy = null;
    broadcast({ type: `${prefix}-busy`, busy: false, kind });
    broadcast({ type: 'job-busy', busy: false, kind });
  }
}

const progress = (prefix) => (p) => broadcast({ type: `${prefix}-progress`, ...(typeof p === 'string' ? { label: p } : p) });

wss.on('connection', (ws) => {
  console.log(`[helper] panel connected (${wss.clients.size} open)`);
  send(ws, { type: 'hello', helperVersion: VERSION, workdir: config.workdir, busy: chat.busy, jobBusy });
  if (chat.lastUsage) send(ws, { type: 'usage', usage: chat.lastUsage });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return send(ws, { type: 'error', error: 'Message was not JSON.' }); }
    try {
      switch (msg.type) {
        case 'ping':
          return send(ws, { type: 'pong', id: msg.id });
        case 'status':
          return send(ws, { type: 'status', id: msg.id, ...(await runChecks()) });

        // ---------- chat ----------
        case 'chat-send': {
          const text = String(msg.text || '').trim();
          if (!text) return;
          broadcast({ type: 'chat-user', text });
          return await chat.send(text);
        }
        case 'chat-stop':
          return chat.stop();
        case 'chat-new':
          chat.reset();
          return broadcast({ type: 'chat-cleared' });

        // ---------- auto-cut ----------
        case 'autocut-analyze':
          return await runJob('auto-cut', 'autocut', async () => {
            session.analysis = null;
            const result = await analyzeSequence(null, msg.settings || {}, progress('autocut'));
            session.analysis = result;
            broadcast({ type: 'autocut-result', result: { ...result, cuts: undefined, cutCount: result.cuts.length,
              cutRanges: result.cuts.map((c) => [c.start, c.end]) } });
          });
        case 'autocut-markers':
          return await runJob('placing cut markers', 'autocut', async () => {
            if (!session.analysis) throw new Error('Run Analyze first.');
            const count = await placeCutMarkers(session.analysis, progress('autocut'));
            session.analysis.markersPlaced = true;
            broadcast({ type: 'autocut-markers', placed: true, count });
          });
        case 'autocut-clear-markers':
          return await runJob('clearing cut markers', 'autocut', async () => {
            const seqId = session.analysis ? session.analysis.sequence.id : (await call('get_premiere_state')).activeSequence?.id;
            if (!seqId) throw new Error('No active sequence.');
            const count = await clearCutMarkers(seqId);
            if (session.analysis) session.analysis.markersPlaced = false;
            broadcast({ type: 'autocut-markers', placed: false, count });
          });
        case 'autocut-apply':
          return await runJob('auto-cut', 'autocut', async () => {
            if (!session.analysis) throw new Error('Run Analyze first.');
            const analysis = session.analysis;
            session.analysis = null; // a plan is only ever applied once
            const result = await applyCuts(analysis, progress('autocut'));
            session.applied = { ...result, sequence: analysis.sequence };
            if (result.backup) session.backup = { ...result.backup, of: analysis.sequence };
            broadcast({ type: 'autocut-applied', result });
          });
        case 'autocut-restore':
          return await runJob('opening the backup', 'autocut', async () => {
            if (!session.backup) throw new Error('No backup from this session.');
            await call('set_active_sequence', { sequence_id: session.backup.id });
            broadcast({ type: 'autocut-restored', backup: session.backup });
          });
        case 'seek': {
          // Quick and harmless, but still never while another job is moving things around.
          if (jobBusy) return send(ws, { type: 'error', error: `Busy with ${jobBusy}.` });
          const t = Math.max(0, Number(msg.t) || 0);
          await call('set_playhead_position', { time_seconds: t });
          return send(ws, { type: 'seeked', t });
        }

        // ---------- captions ----------
        case 'captions-make':
          return await runJob('captions', 'captions', async () => {
            const result = await makeCaptions(msg.options || {}, progress('captions'));
            session.captions = result;
            broadcast({ type: 'captions-done', result });
          });

        // ---------- clients ----------
        case 'clients-list':
          return send(ws, { type: 'clients', id: msg.id, ...listClients(config) });
        case 'client-get':
          return send(ws, { type: 'client', id: msg.id, client: getClient(config, msg.client) });

        // ---------- QA and handoff ----------
        case 'qa-run':
          return await runJob('QA checks', 'qa', async () => {
            session.qa = await runQa(config, msg.client || null);
            broadcast({ type: 'qa-result', result: session.qa });
          });
        case 'handoff-draft': {
          const clientName = msg.client ? getClient(config, msg.client).name : null;
          const text = draftHandoff({ clientName, qa: session.qa, autocut: session.applied, captions: session.captions, note: msg.note });
          return send(ws, { type: 'handoff-draft', text });
        }

        default:
          return send(ws, { type: 'error', id: msg.id, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      console.error('[helper] request failed:', err);
      send(ws, { type: msg.type && msg.type.startsWith('chat') ? 'chat-error' : 'error', id: msg.id, request: msg.type, error: String(err && err.message || err) });
    }
  });

  ws.on('close', () => console.log(`[helper] panel disconnected (${wss.clients.size} open)`));
});

wss.on('listening', () => console.log(`[helper] Editing Assistant helper ${VERSION} listening on ws://127.0.0.1:${PORT}/panel (Claude works in ${config.workdir})`));
wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`[helper] Port ${PORT} is busy. Is another helper already running?`);
  else console.error('[helper] server error:', err);
  process.exit(1);
});

process.on('SIGINT', () => { chat.stop(); process.exit(0); });
