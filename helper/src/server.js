// Editing Assistant helper: a local WebSocket server the Premiere panel connects to.
// Listens on 127.0.0.1 only, so nothing outside this computer can reach it.
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { runChecks } from './checks.js';
import { Chats } from './chats.js';
import { APP_DATA } from './paths.js';
import { loadConfig } from './config.js';
import { acknowledgeRecovery, call, callRaw, close as closePremiere, inspectRecovery, listTools } from './premiere.js';

import { analyzeSequence } from './autocut/index.js';
import { applyCuts, undoCuts } from './autocut/apply.js';
import { clearCutMarkers, placeCutMarkers } from './autocut/markers.js';
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

// Saved chats shared by every open panel; each keeps its own Claude Code conversation.
const chat = new Chats({ workdir: config.workdir, onEvent: broadcast });

// What this session has done, for Apply, Undo cuts and the handoff draft. The last applied auto-cut
// and its backup are kept on disk, so Undo cuts still works after the helper restarts.
const SESSION_FILE = path.join(APP_DATA, 'autocut-session.json');
const session = { analysis: null, applied: null, backup: null, qa: null };
try { Object.assign(session, JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))); } catch { /* nothing saved yet */ }
function saveSession() {
  try {
    fs.mkdirSync(APP_DATA, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ applied: session.applied, backup: session.backup }));
  } catch (err) { console.error('[helper] could not save the auto-cut session:', err.message); }
}

// Premiere jobs run one at a time (they share the active sequence, playhead and undo history).
let jobBusy = null;
// Stop for the running auto-cut job (analysis, markers or apply).
let jobAbort = null;

async function runJob(kind, prefix, job) {
  if (jobBusy) throw new Error(`Busy with ${jobBusy}. Try again when it finishes.`);
  jobBusy = kind;
  broadcast({ type: 'job-busy', busy: true, kind });
  broadcast({ type: `${prefix}-busy`, busy: true, kind });
  try {
    await job();
  } catch (err) {
    if (err.stopped) {
      broadcast({ type: `${prefix}-stopped`, kind });
      return;
    }
    console.error(`[helper] ${kind} failed:`, err);
    const message = err.recovery ? 'Premiere wants a safety check before more edits. Use Review safety check at the top of the panel.' : err.message;
    broadcast({ type: `${prefix}-error`, kind, error: message, recovery: !!err.recovery });
  } finally {
    jobBusy = null;
    jobAbort = null;
    broadcast({ type: `${prefix}-busy`, busy: false, kind });
    broadcast({ type: 'job-busy', busy: false, kind });
  }
}

// What the editor is looking at, sent along with each chat message so "this clip" just works.
// Best effort: skipped while a Premiere job runs, given up on after 1.5 s, and not retried for a
// minute after a failure, so a closed Premiere doesn't slow every message down.
let contextFailedAt = 0;
async function premiereContext() {
  if (jobBusy || Date.now() - contextFailedAt < 60000) return '';
  try {
    const s = await Promise.race([call('get_premiere_state'), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 1500))]);
    const seq = s.activeSequence;
    if (!seq) return 'Premiere right now: no sequence is open.';
    const sel = (s.selectedClips || []).map((c) => `"${c.name}" (node ${c.nodeId})`).join(', ');
    return `Premiere right now: active sequence "${seq.name}" (id ${seq.id}), playhead at ${Number(s.playheadSeconds || 0).toFixed(2)}s, `
      + (sel ? `selected clips: ${sel}.` : 'no clips selected.');
  } catch {
    contextFailedAt = Date.now();
    return '';
  }
}

const progress = (prefix) => (p) => broadcast({ type: `${prefix}-progress`, ...(typeof p === 'string' ? { label: p } : p) });

wss.on('connection', (ws) => {
  console.log(`[helper] panel connected (${wss.clients.size} open)`);
  send(ws, { type: 'hello', helperVersion: VERSION, workdir: config.workdir, busyChatId: chat.busyChatId, jobBusy,
    undo: session.backup ? { backup: session.backup.name, of: session.backup.of.name } : null });
  if (chat.lastUsage) send(ws, { type: 'usage', usage: chat.lastUsage });
  send(ws, { type: 'chats', chats: chat.summary(), busyChatId: chat.busyChatId });

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
        case 'chats-list':
          return send(ws, { type: 'chats', chats: chat.summary(), busyChatId: chat.busyChatId });
        case 'chat-open': {
          const c = chat.get(String(msg.chatId));
          send(ws, { type: 'chat-opened', chat: { id: c.id, title: c.title, messages: c.messages }, busy: chat.busyChatId === c.id });
          return chat.warm(c.id);
        }
        case 'chat-create': {
          const c = chat.create();
          send(ws, { type: 'chat-opened', chat: { id: c.id, title: c.title, messages: [] }, busy: false });
          return chat.warm(c.id);
        }
        case 'chat-rename':
          return chat.rename(String(msg.chatId), msg.title);
        case 'chat-delete':
          return chat.delete(String(msg.chatId));
        case 'chat-send': {
          const text = String(msg.text || '').trim();
          if (!text) return;
          return await chat.send(String(msg.chatId), text, await premiereContext());
        }
        case 'chat-stop':
          return chat.stop();
        // ---------- the chat's tool server (tools-mcp.js) ----------
        case 'premiere-tools':
          return send(ws, { type: 'premiere-tools-result', id: msg.id, tools: await listTools() });
        case 'premiere-call': {
          const tool = String(msg.tool || '');
          const reply = (r) => send(ws, { type: 'premiere-call-result', id: msg.id, ...r });
          const textResult = (t) => reply({ isError: true, content: [{ type: 'text', text: t }] });
          if (jobBusy) return textResult(`Premiere is busy with ${jobBusy} from the panel. Try again when it finishes.`);
          try {
            const res = await callRaw(tool, msg.args || {});
            return reply({ content: res.content, isError: !!res.isError });
          } catch (err) {
            return textResult(String(err.message || err));
          }
        }
        case 'usage-check':
          try {
            await chat.checkUsage();
          } catch (err) {
            send(ws, { type: 'usage-error', error: String(err.message || err) });
          }
          return;

        // ---------- auto-cut ----------
        case 'autocut-analyze':
          return await runJob('auto-cut', 'autocut', async () => {
            session.analysis = null;
            jobAbort = new AbortController();
            const result = await analyzeSequence(null, msg.settings || {}, progress('autocut'), jobAbort.signal);
            session.analysis = result;
            broadcast({ type: 'autocut-result', result: { ...result, cuts: undefined, cutCount: result.cuts.length,
              cutRanges: result.cuts.map((c) => [c.start, c.end]) } });
          });
        case 'autocut-markers':
          return await runJob('placing cut markers', 'autocut', async () => {
            if (!session.analysis) throw new Error('Run Analyze first.');
            jobAbort = new AbortController();
            const count = await placeCutMarkers(session.analysis, progress('autocut'), jobAbort.signal);
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
            jobAbort = new AbortController();
            const result = await applyCuts(analysis, progress('autocut'), jobAbort.signal);
            session.applied = { ...result, sequence: analysis.sequence };
            if (result.backup) session.backup = { ...result.backup, of: analysis.sequence };
            saveSession();
            broadcast({ type: 'autocut-applied', result });
          });
        case 'autocut-stop':
          if (jobAbort) jobAbort.abort();
          return broadcast({ type: 'autocut-progress', label: 'Stopping after the current step…' });
        case 'autocut-undo':
          return await runJob('undoing the cuts', 'autocut', async () => {
            if (!session.backup) throw new Error('There is no auto-cut to undo.');
            const result = await undoCuts(session.backup);
            session.backup = null;
            session.applied = null;
            saveSession();
            broadcast({ type: 'autocut-undone', result });
          });
        case 'recovery-check':
          if (jobBusy) return send(ws, { type: 'error', error: `Busy with ${jobBusy}.` });
          return send(ws, { type: 'recovery', ...(await inspectRecovery()) });
        case 'recovery-ack':
          if (jobBusy) return send(ws, { type: 'error', error: `Busy with ${jobBusy}.` });
          await acknowledgeRecovery(String(msg.recoveryRevision), String(msg.hostStateRevision));
          return broadcast({ type: 'recovery', required: false, cleared: true });
        case 'seek': {
          // Quick and harmless, but still never while another job is moving things around.
          if (jobBusy) return send(ws, { type: 'error', error: `Busy with ${jobBusy}.` });
          const t = Math.max(0, Number(msg.t) || 0);
          await call('set_playhead_position', { time_seconds: t });
          return send(ws, { type: 'seeked', t });
        }

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
          const text = draftHandoff({ clientName, qa: session.qa, autocut: session.applied, note: msg.note });
          return send(ws, { type: 'handoff-draft', text });
        }

        default:
          return send(ws, { type: 'error', id: msg.id, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      console.error('[helper] request failed:', err);
      send(ws, { type: msg.type && msg.type.startsWith('chat') ? 'chat-error' : 'error', id: msg.id, request: msg.type, chatId: msg.chatId, error: String(err && err.message || err) });
    }
  });

  ws.on('close', () => console.log(`[helper] panel disconnected (${wss.clients.size} open)`));
});

wss.on('listening', () => {
  console.log(`[helper] Editing Assistant helper ${VERSION} listening on ws://127.0.0.1:${PORT}/panel (Claude works in ${config.workdir})`);
  // Start the Premiere connector and cache its tool list now: chats need the list before their first
  // reply, and starting the connector (npx) takes several seconds.
  listTools().catch((err) => console.error('[helper] Premiere connector not ready yet:', err.message));
});
wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`[helper] Port ${PORT} is busy. Is another helper already running?`);
  else console.error('[helper] server error:', err);
  process.exit(1);
});

// Close the Premiere connection cleanly on the way out; a connection cut off mid-session makes
// Premiere ask for a safety check before the next edit.
async function shutdown() {
  chat.stop();
  await Promise.race([closePremiere(), new Promise((r) => setTimeout(r, 2000))]);
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, shutdown);
// One unexpected error (a dropped Premiere connection, a bad reply) shouldn't take the panel offline.
process.on('uncaughtException', (err) => console.error('[helper] unexpected error, still running:', err));
process.on('unhandledRejection', (err) => console.error('[helper] unexpected error, still running:', err));
