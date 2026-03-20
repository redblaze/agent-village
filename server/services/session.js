import { randomUUID } from 'crypto';
import { config } from '../config/env.js';

const sessions = new Map(); // Map<sessionId, { messages: [], lastUsed: number }>

export function createSession() {
  const id = randomUUID();
  sessions.set(id, { messages: [], lastUsed: Date.now() });
  return id;
}

// Returns messages array (never null — returns [] for unknown/expired sessionId)
export function getHistory(sessionId) {
  if (!sessionId) return [];
  const session = sessions.get(sessionId);
  if (!session) return [];
  session.lastUsed = Date.now();
  return session.messages;
}

// Appends turn and trims to max history cap (keeps most recent N messages)
export function appendToHistory(sessionId, role, content) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.messages.push({ role, content });
  if (session.messages.length > config.sessionMaxHistory) {
    session.messages = session.messages.slice(-config.sessionMaxHistory);
  }
  session.lastUsed = Date.now();
}

// Check if a session exists (used to detect expired sessions in respondToMessage)
export function sessionExists(sessionId) {
  return sessions.has(sessionId);
}

export function cleanExpiredSessions() {
  const cutoff = Date.now() - config.sessionTtlMs;
  for (const [id, s] of sessions.entries()) {
    if (s.lastUsed < cutoff) sessions.delete(id);
  }
}
