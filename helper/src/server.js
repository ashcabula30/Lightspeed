// Editing Assistant helper: a local WebSocket server the Premiere panel connects to.
// Listens on 127.0.0.1 only, so nothing outside this computer can reach it.
import { WebSocketServer } from 'ws';
import { runChecks } from './checks.js';
import { ClaudeChat } from './claude.js';
import { loadConfig } from './config.js';
import { analyzeSequence } from './autocut/index.js';
import { applyCuts } from './autocut/apply.js';

export const PORT = Number(process.env.EA_PORT || 7790);
const VERSION = '0.3.0';
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

// Auto-cut: one job at a time; Apply only ever uses the most recent analysis.
const autocut = { busy: false, analysis: null };

async function runAutocut(kind, job) {
  if (autocut.busy) throw new Error('Auto-cut is already running.');
  autocut.busy = true;
  broadcast({ type: 'autocut-busy', busy: true, kind });
  try {
    await job();
  } catch (err) {
    console.error(`[helper] auto-cut ${kind} failed:`, err);
    const hint = err.recovery ? ' Premiere asked for a safety check after an earlier failed command; ask in the chat to inspect and acknowledge the recovery, then try again.' : '';
    broadcast({ type: 'autocut-error', kind, error: `${err.message}${hint}` });
  } finally {
    autocut.busy = false;
    broadcast({ type: 'autocut-busy', busy: false, kind });
  }
}

wss.on('connection', (ws) => {
  console.log(`[helper] panel connected (${wss.clients.size} open)`);
  send(ws, { type: 'hello', helperVersion: VERSION, workdir: config.workdir, busy: chat.busy });
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
        case 'autocut-analyze':
          return await runAutocut('analyze', async () => {
            autocut.analysis = null;
            const result = await analyzeSequence(null, msg.settings || {}, (label) => broadcast({ type: 'autocut-progress', label }));
            autocut.analysis = result;
            broadcast({ type: 'autocut-result', result: { ...result, cuts: undefined, cutCount: result.cuts.length } });
          });
        case 'autocut-apply':
          return await runAutocut('apply', async () => {
            if (!autocut.analysis) throw new Error('Run Analyze first.');
            const analysis = autocut.analysis;
            autocut.analysis = null; // a plan is only ever applied once
            const result = await applyCuts(analysis, (p) => broadcast({ type: 'autocut-progress', ...p }));
            broadcast({ type: 'autocut-applied', result });
          });
        default:
          return send(ws, { type: 'error', id: msg.id, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      console.error('[helper] request failed:', err);
      send(ws, { type: msg.type && msg.type.startsWith('chat') ? 'chat-error' : 'error', id: msg.id, error: String(err && err.message || err) });
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
