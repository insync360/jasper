'use strict';

/**
 * In-memory conversation store, keyed by WhatsApp number.
 * Serves two purposes:
 *   1. LLM short-term memory  — getHistory() feeds recent turns to Claude.
 *   2. Full transcript buffer — takeUnsynced() yields turns to persist to Salesforce.
 *
 * Notes / trade-offs:
 *  - In-memory: fine while the dyno is warm (an active chat keeps it awake). If the
 *    Eco dyno sleeps after ~30 min idle, memory resets — which coincides with a new
 *    conversation anyway. The durable record lives in Salesforce (the synced turns).
 *  - Each entry tracks `synced` = how many turns have been written to Salesforce.
 */
const STORE = new Map();
const TTL_MS = 30 * 60 * 1000; // forget a conversation after 30 min idle
const MAX_TURNS = 40; // cap memory per conversation
const MAX_LEN = 2000; // cap a single turn's length

function entry(phone) {
  const now = Date.now();
  let e = STORE.get(phone);
  if (e && now - e.ts > TTL_MS) {
    STORE.delete(phone);
    e = null;
  }
  if (!e) {
    e = { turns: [], synced: 0, ts: now };
    STORE.set(phone, e);
  }
  return e;
}

/** Append a turn. role: 'user' | 'assistant'. */
function record(phone, role, content) {
  if (!phone || !content) return;
  const e = entry(phone);
  e.turns.push({ role, content: String(content).slice(0, MAX_LEN) });
  e.ts = Date.now();
  if (e.turns.length > MAX_TURNS) {
    const drop = e.turns.length - MAX_TURNS;
    e.turns.splice(0, drop);
    e.synced = Math.max(0, e.synced - drop);
  }
}

/** Last `limit` turns as [{role, content}] — for the LLM. */
function getHistory(phone, limit = 12) {
  return entry(phone).turns.slice(-limit).map((t) => ({ role: t.role, content: t.content }));
}

/** Turns not yet written to Salesforce; marks them synced. */
function takeUnsynced(phone) {
  const e = entry(phone);
  const out = e.turns.slice(e.synced);
  e.synced = e.turns.length;
  return out;
}

/** Salesforce WhatsApp_Conversation__c record id for this session (for upserts). */
function getConvoId(phone) {
  return entry(phone).convoId || null;
}
function setConvoId(phone, id) {
  entry(phone).convoId = id;
}

/** Build a readable, consolidated transcript of the whole session. */
function getTranscript(phone) {
  const e = entry(phone);
  const text = e.turns.map((t) => `${t.role === 'user' ? 'Customer' : 'Bot'}: ${t.content}`).join('\n');
  return { text, count: e.turns.length };
}

/** Per-conversation flow state (e.g. an in-progress test-ride booking). */
function getState(phone) {
  return entry(phone).state || null;
}
function setState(phone, state) {
  entry(phone).state = state;
}
function clearState(phone) {
  entry(phone).state = null;
}

module.exports = {
  record,
  getHistory,
  takeUnsynced,
  getConvoId,
  setConvoId,
  getTranscript,
  getState,
  setState,
  clearState,
};
