// Saved chats for the chat window: each one keeps its own Claude Code conversation (resumed by
// session id) and its messages, stored on disk so the list and history survive restarts.
// Only one chat answers at a time (one Claude Code process).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeChat } from './claude.js';

const FILE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'EditingAssistant', 'chats.json');
const MAX_MESSAGES = 300; // per chat, oldest dropped first
const NEW_TITLE = 'New chat';
// Only Premiere tools can be allowed for a whole chat; anything else is approved one reply at a time.
const ALWAYS_OK = /^mcp__premiere-pro__/;

export const toolLabel = (t) => t.replace(/^mcp__premiere-pro__/, 'Premiere: ').replace(/^mcp__([^_]+)__/, '$1: ');

export class Chats {
  constructor({ workdir, onEvent }) {
    this.onEvent = onEvent;
    this.chats = this.load();
    this.answering = null;  // id of the chat Claude is replying in
    this.openReply = false; // whether the next text delta continues the last assistant message
    this.claude = new ClaudeChat({ workdir, onEvent: (ev) => this.fromClaude(ev) });
  }

  get busyChatId() { return this.answering; }
  get lastUsage() { return this.claude.lastUsage; }
  checkUsage() { return this.claude.checkUsage(); }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(this.chats));
    } catch (err) { console.error('[helper] could not save chats:', err.message); }
  }

  summary() {
    return [...this.chats].sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length }));
  }

  listChanged() {
    this.onEvent({ type: 'chats', chats: this.summary(), busyChatId: this.answering });
  }

  get(id) {
    const chat = this.chats.find((c) => c.id === id);
    if (!chat) throw new Error('That chat no longer exists.');
    return chat;
  }

  create() {
    const now = Date.now();
    const chat = { id: crypto.randomUUID(), title: NEW_TITLE, sessionId: null, allowedTools: [], createdAt: now, updatedAt: now, messages: [] };
    this.chats.push(chat);
    this.save();
    this.listChanged();
    return chat;
  }

  rename(id, title) {
    const chat = this.get(id);
    chat.title = String(title || '').trim().slice(0, 80) || chat.title;
    this.save();
    this.listChanged();
  }

  delete(id) {
    if (this.answering === id) throw new Error('Wait for this chat to finish answering, or press Stop first.');
    this.chats = this.chats.filter((c) => c.id !== id);
    this.save();
    this.listChanged();
  }

  push(chat, kind, text, extra = {}) {
    chat.messages.push({ kind, text, at: Date.now(), ...extra });
    if (chat.messages.length > MAX_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
    chat.updatedAt = Date.now();
  }

  // allowOnce: tools the editor approved for this one reply.
  async send(id, text, allowOnce = []) {
    if (this.claude.busy) throw new Error('Claude is still answering in another chat. Wait for it, or press Stop.');
    const chat = this.get(id);
    if (chat.title === NEW_TITLE) chat.title = text.replace(/\s+/g, ' ').slice(0, 48) + (text.length > 48 ? '…' : '');
    this.push(chat, 'user', text);
    this.answering = id;
    this.openReply = false;
    this.claude.sessionId = chat.sessionId; // continue this chat's own conversation
    this.save();
    this.onEvent({ type: 'chat-user', chatId: id, text });
    this.listChanged();
    try {
      await this.claude.send(text, [...(chat.allowedTools || []), ...allowOnce]);
    } catch (err) {
      this.finish(chat, 'error', err.message);
      throw err;
    }
  }

  stop() {
    this.claude.stop();
  }

  // mode: 'once' (this reply), 'always' (Premiere tools, for the rest of this chat) or 'deny'.
  async approve(id, approvalId, mode) {
    const chat = this.get(id);
    const msg = chat.messages.find((m) => m.approval && m.approval.id === approvalId);
    if (!msg) throw new Error('That approval is no longer in this chat.');
    if (msg.approval.resolved) throw new Error('That approval was already answered.');
    if (mode === 'always' && !msg.approval.canAlways) throw new Error('Only Premiere tools can be allowed for the whole chat.');
    if (mode !== 'deny' && this.claude.busy) throw new Error('Claude is answering in another chat. Wait for it, or press Stop.');
    msg.approval.resolved = mode;
    this.onEvent({ type: 'chat-approval-resolved', chatId: id, approvalId, mode });
    if (mode === 'deny') {
      this.save();
      return;
    }
    const tools = msg.approval.tools;
    if (mode === 'always') chat.allowedTools = [...new Set([...(chat.allowedTools || []), ...tools])];
    await this.send(id, `Approved: go ahead with ${tools.map(toolLabel).join(', ')}.`, tools);
  }

  finish(chat, kind, text) {
    if (text) this.push(chat, kind, text);
    if (this.claude.sessionId) chat.sessionId = this.claude.sessionId;
    this.answering = null;
    this.openReply = false;
    this.save();
    this.listChanged();
  }

  // Claude Code events: store them in the chat being answered, then pass them on tagged with it.
  fromClaude(ev) {
    if (ev.type === 'usage') return this.onEvent(ev);
    const chat = this.answering && this.chats.find((c) => c.id === this.answering);
    if (!chat) return;
    const chatId = chat.id;
    switch (ev.type) {
      case 'chat-delta': {
        const last = chat.messages[chat.messages.length - 1];
        if (this.openReply && last && last.kind === 'assistant') last.text += ev.text;
        else this.push(chat, 'assistant', ev.text);
        this.openReply = true;
        break;
      }
      case 'chat-block':
      case 'chat-tool':
        this.openReply = false; // text after a tool call starts a new message
        break;
      case 'chat-done': {
        this.onEvent({ ...ev, chatId });
        const denied = (ev.denied || []).filter((d, i, a) => a.indexOf(d) === i);
        if (ev.isError) this.push(chat, 'error', ev.error || 'Claude reported an error.');
        if (denied.length) {
          // An approval card: the editor can allow the blocked tools and let Claude carry on.
          const card = { id: crypto.randomUUID(), tools: denied, details: ev.deniedDetails || [], resolved: null,
            canAlways: denied.every((t) => ALWAYS_OK.test(t)) };
          this.push(chat, 'approval', `Claude needs your OK to use ${denied.map(toolLabel).join(', ')}.`, { approval: card });
          this.onEvent({ type: 'chat-approval', chatId, message: chat.messages[chat.messages.length - 1] });
        }
        this.finish(chat, null, null);
        return;
      }
      case 'chat-error':
        this.onEvent({ ...ev, chatId });
        this.finish(chat, 'error', ev.error);
        return;
      default:
        break;
    }
    this.onEvent({ ...ev, chatId });
  }
}
