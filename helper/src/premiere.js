// Talks to Premiere through the premiere-pro-mcp server (CEP connector panel must be open in Premiere).
// The helper is an MCP client: it starts the server once and calls its tools directly, no AI involved.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const isWin = process.platform === 'win32';
const PACKAGE = 'premiere-pro-mcp@1.24.3';

let client = null;
let connecting = null;

async function connect() {
  const transport = new StdioClientTransport(isWin
    ? { command: 'cmd', args: ['/c', 'npx', '--yes', PACKAGE], stderr: 'ignore' }
    : { command: 'npx', args: ['--yes', PACKAGE], stderr: 'ignore' });
  const c = new Client({ name: 'editing-assistant-helper', version: '0.3.0' });
  transport.onclose = () => { if (client === c) client = null; };
  await c.connect(transport);
  return c;
}

async function getClient() {
  if (client) return client;
  if (!connecting) connecting = connect().then((c) => { client = c; return c; }).finally(() => { connecting = null; });
  return connecting;
}

export class PremiereError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
    this.recovery = /HOST_RECOVERY_REQUIRED/.test(message);
    this.busy = /busy or blocked/i.test(message);
  }
}

// Calls one premiere-pro-mcp tool and returns its `data`, or throws PremiereError.
export async function call(tool, args = {}) {
  const c = await getClient();
  const res = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 10 * 60 * 1000 });
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (res.isError) throw new PremiereError(text.replace(/^Error:\s*/, '').split('\n')[0] || `${tool} failed`, text);
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text; }
  if (parsed && parsed.ok === false) throw new PremiereError(parsed.error || `${tool} failed`, parsed);
  return parsed && 'data' in parsed ? parsed.data : parsed;
}

// For the chat's tool server: the connector's full tool list, and calls passed through unchanged,
// so the chat shares this one long-lived connection instead of opening (and dropping) its own.
let toolList = null;
export async function listTools() {
  if (toolList) return toolList;
  const c = await getClient();
  const tools = [];
  let cursor;
  do {
    const page = await c.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  toolList = tools;
  return tools;
}

export async function callRaw(tool, args = {}) {
  const c = await getClient();
  return c.callTool({ name: tool, arguments: args }, undefined, { timeout: 10 * 60 * 1000 });
}

export async function close() {
  if (client) await client.close().catch(() => {});
  client = null;
}

// Premiere's connector blocks edits after a command that didn't finish cleanly (for example the
// helper being closed mid-session) until someone reviews the current state and acknowledges it.
const REASONS = {
  abandoned_process_lease: 'The helper was closed while it was connected to Premiere.',
};

export async function inspectRecovery() {
  const r = await call('inspect_operation_recovery', { backend: 'cep' });
  if (!r.recoveryRequired) return { required: false };
  const clips = (r.snapshot && r.snapshot.clips) || [];
  return {
    required: true,
    reason: REASONS[r.reason] || `Premiere reported: ${r.reason}.`,
    clipCount: clips.length,
    recoveryRevision: r.recoveryRevision,
    hostStateRevision: r.hostStateRevision,
  };
}

export async function acknowledgeRecovery(recoveryRevision, hostStateRevision) {
  await call('acknowledge_operation_recovery', { backend: 'cep', expected_recovery_revision: recoveryRevision,
    expected_host_state_revision: hostStateRevision, reviewed: true });
}
