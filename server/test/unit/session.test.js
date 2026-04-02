import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock config before session.js is imported so sessionMaxHistory / sessionTtlMs
// are under test control and independent of real env vars.
vi.mock('../../config/env.js', () => ({
  config: {
    sessionMaxHistory: 3,
    sessionTtlMs: 1000, // 1 second — makes expiry tests fast
  },
}));

import {
  createSession,
  getHistory,
  appendToHistory,
  sessionExists,
  cleanExpiredSessions,
} from '../../services/session.js';

describe('createSession', () => {
  it('returns a non-empty string ID', () => {
    const id = createSession();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('each call returns a unique ID', () => {
    const a = createSession();
    const b = createSession();
    expect(a).not.toBe(b);
  });
});

describe('getHistory', () => {
  it('returns [] for unknown sessionId', () => {
    expect(getHistory('does-not-exist-xyz')).toEqual([]);
  });

  it('returns [] when sessionId is null or undefined', () => {
    expect(getHistory(null)).toEqual([]);
    expect(getHistory(undefined)).toEqual([]);
  });

  it('returns messages array for existing session', () => {
    const id = createSession();
    appendToHistory(id, 'user', 'hello');
    const history = getHistory(id);
    expect(history).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('updates lastUsed timestamp on access (session survives TTL refresh)', () => {
    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(base);

    const id = createSession();

    // Advance to just before expiry
    vi.setSystemTime(base + 900);
    getHistory(id); // refreshes lastUsed to base+900

    // Advance past the original creation time + TTL but before refreshed + TTL
    vi.setSystemTime(base + 1500); // original would expire, refreshed (base+900+1000=1900) still ok
    cleanExpiredSessions();

    expect(sessionExists(id)).toBe(true);
    vi.useRealTimers();
  });

  it('returns [] for an expired and cleaned session', () => {
    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(base);

    const id = createSession();
    vi.setSystemTime(base + 2000); // past TTL of 1000ms
    cleanExpiredSessions();

    expect(getHistory(id)).toEqual([]);
    vi.useRealTimers();
  });
});

describe('appendToHistory', () => {
  it('is a no-op for unknown sessionId', () => {
    expect(() => appendToHistory('ghost-session', 'user', 'hi')).not.toThrow();
  });

  it('appends { role, content } object to messages', () => {
    const id = createSession();
    appendToHistory(id, 'user', 'first');
    appendToHistory(id, 'assistant', 'second');
    expect(getHistory(id)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]);
  });

  it('trims to sessionMaxHistory keeping the most recent messages', () => {
    const id = createSession();
    // sessionMaxHistory is 3; push 5 messages
    appendToHistory(id, 'user', 'msg1');
    appendToHistory(id, 'assistant', 'msg2');
    appendToHistory(id, 'user', 'msg3');
    appendToHistory(id, 'assistant', 'msg4');
    appendToHistory(id, 'user', 'msg5');

    const history = getHistory(id);
    expect(history).toHaveLength(3);
    // Keeps the most recent 3
    expect(history[0].content).toBe('msg3');
    expect(history[1].content).toBe('msg4');
    expect(history[2].content).toBe('msg5');
  });

  it('updates lastUsed on append', () => {
    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(base);

    const id = createSession();
    vi.setSystemTime(base + 900);
    appendToHistory(id, 'user', 'ping'); // refreshes lastUsed

    vi.setSystemTime(base + 1500); // would expire from creation time, but not from append time
    cleanExpiredSessions();

    expect(sessionExists(id)).toBe(true);
    vi.useRealTimers();
  });
});

describe('sessionExists', () => {
  it('returns false for unknown sessionId', () => {
    expect(sessionExists('totally-unknown-id')).toBe(false);
  });

  it('returns true for existing session', () => {
    const id = createSession();
    expect(sessionExists(id)).toBe(true);
  });

  it('does NOT update lastUsed (session expires at original TTL)', () => {
    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(base);

    const id = createSession();
    // Call sessionExists many times (should not refresh lastUsed)
    vi.setSystemTime(base + 900);
    sessionExists(id);
    sessionExists(id);

    vi.setSystemTime(base + 1500); // TTL from creation time has passed
    cleanExpiredSessions();

    // sessionExists does not refresh lastUsed, so the session is now expired
    expect(sessionExists(id)).toBe(false);
    vi.useRealTimers();
  });
});

describe('cleanExpiredSessions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes sessions older than sessionTtlMs', () => {
    const base = Date.now();
    vi.setSystemTime(base);
    const id = createSession();

    vi.setSystemTime(base + 2000);
    cleanExpiredSessions();

    expect(sessionExists(id)).toBe(false);
  });

  it('keeps sessions that are still fresh', () => {
    const base = Date.now();
    vi.setSystemTime(base);
    const id = createSession();

    vi.setSystemTime(base + 500); // half the TTL
    cleanExpiredSessions();

    expect(sessionExists(id)).toBe(true);
  });

  it('does not affect sessions with recent activity', () => {
    const base = Date.now();
    vi.setSystemTime(base);
    const id = createSession();

    vi.setSystemTime(base + 900);
    getHistory(id); // refreshes lastUsed

    vi.setSystemTime(base + 1200); // past creation TTL, but not past refreshed TTL
    cleanExpiredSessions();

    expect(sessionExists(id)).toBe(true);
  });
});
