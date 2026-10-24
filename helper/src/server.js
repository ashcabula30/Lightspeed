// Editing Assistant helper: a local WebSocket server the Premiere panel connects to.
// Listens on 127.0.0.1 only, so nothing outside this computer can reach it.
import { WebSocketServer } from 'ws';
import { runChecks } from './checks.js';

export const PORT = Number(process.env.EA_PORT || 7790);
const VERSION = '0.1.0';

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT, path: '/panel' });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  console.log(`[helper] panel connected (${wss.clients.size} open)`);
  send(ws, { type: 'hello', helperVersion: VERSION });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return send(ws, { type: 'error', error: 'Message was not JSON.' }); }
    try {
      switch (msg.type) {
        case 'ping':
          return send(ws, { type: 'pong', id: msg.id });
        case 'status':
          return send(ws, { type: 'status', id: msg.id, ...(await runChecks()) });
        default:
          return send(ws, { type: 'error', id: msg.id, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      console.error('[helper] request failed:', err);
      send(ws, { type: 'error', id: msg.id, error: String(err && err.message || err) });
    }
  });

  ws.on('close', () => console.log(`[helper] panel disconnected (${wss.clients.size} open)`));
});

wss.on('listening', () => console.log(`[helper] Editing Assistant helper ${VERSION} listening on ws://127.0.0.1:${PORT}/panel`));
wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`[helper] Port ${PORT} is busy. Is another helper already running?`);
  else console.error('[helper] server error:', err);
  process.exit(1);
});
