import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  config: { proactiveCooldownMs: 3_600_000 }, // 1 hour
}));

// Stub all DB and LLM imports that proactivePolicy.js pulls in transitively
vi.mock('../../db/client.js', () => ({ supabase: {} }));
vi.mock('../../db/agents.js', () => ({
  getNonSensitiveMemories: vi.fn().mockResolvedValue([]),
  getPrivateMemoryTexts: vi.fn().mockResolvedValue([]),
  getAgentById: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../db/feed.js', () => ({
  getRecentActionLogs: vi.fn().mockResolvedValue([]),
  getDiaryEntryById: vi.fn().mockResolvedValue(null),
  getLogEntryById: vi.fn().mockResolvedValue(null),
  addSkill: vi.fn().mockResolvedValue(undefined),
  getAgentSkills: vi.fn().mockResolvedValue([]),
  getActivityEventById: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../services/llm.js', () => ({ chat: vi.fn().mockResolvedValue('') }));
vi.mock('../../services/eventBus.js', () => ({ trigger: vi.fn(), respondTo: vi.fn() }));

import { shouldActProactively, selectProactiveAction } from '../../middleware/proactivePolicy.js';

const HOUR = 3_600_000;
const COOLDOWN = HOUR; // matches mocked proactiveCooldownMs

describe('shouldActProactively', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const now = new Date('2025-01-01T12:00:00Z').getTime(); // noon, non-peak hour

  it('returns true when last_proactive_at is null (never acted)', () => {
    vi.setSystemTime(now);
    const agent = {
      last_proactive_at: null,
      updated_at: new Date(now - 3 * HOUR).toISOString(), // inactive 3h
    };
    expect(shouldActProactively(agent)).toBe(true);
  });

  it('returns false when last_proactive_at is within cooldown window', () => {
    vi.setSystemTime(now);
    const agent = {
      last_proactive_at: new Date(now - 30 * 60 * 1000).toISOString(), // 30 min ago
      updated_at: new Date(now - 3 * HOUR).toISOString(),
    };
    expect(shouldActProactively(agent)).toBe(false);
  });

  it('returns true when last_proactive_at is beyond cooldown AND inactive 2+ hours', () => {
    vi.setSystemTime(now);
    const agent = {
      last_proactive_at: new Date(now - 2 * HOUR).toISOString(), // 2h ago — past cooldown
      updated_at: new Date(now - 3 * HOUR).toISOString(),        // inactive 3h
    };
    expect(shouldActProactively(agent)).toBe(true);
  });

  it('returns false when past cooldown but active within 2 hours and not peak hour', () => {
    // noon is not a peak hour (peak: 9, 18, 22)
    vi.setSystemTime(now);
    const agent = {
      last_proactive_at: new Date(now - 2 * HOUR).toISOString(), // past cooldown
      updated_at: new Date(now - 1 * HOUR).toISOString(),        // active 1h ago (< 2h)
    };
    expect(shouldActProactively(agent)).toBe(false);
  });

  it('returns true at peak hour 9 when inactive 2+ hours and past cooldown', () => {
    const nineAM = new Date('2025-01-01T09:00:00').getTime();
    vi.setSystemTime(nineAM);
    const agent = {
      last_proactive_at: new Date(nineAM - 2 * HOUR).toISOString(),
      updated_at: new Date(nineAM - 3 * HOUR).toISOString(),
    };
    expect(shouldActProactively(agent)).toBe(true);
  });

  it('returns true at peak hour 18', () => {
    const sixPM = new Date('2025-01-01T18:00:00').getTime();
    vi.setSystemTime(sixPM);
    const agent = {
      last_proactive_at: new Date(sixPM - 2 * HOUR).toISOString(),
      updated_at: new Date(sixPM - 3 * HOUR).toISOString(),
    };
    expect(shouldActProactively(agent)).toBe(true);
  });

  it('returns true at peak hour 22', () => {
    const tenPM = new Date('2025-01-01T22:00:00').getTime();
    vi.setSystemTime(tenPM);
    const agent = {
      last_proactive_at: new Date(tenPM - 2 * HOUR).toISOString(),
      updated_at: new Date(tenPM - 3 * HOUR).toISOString(),
    };
    expect(shouldActProactively(agent)).toBe(true);
  });

  it('returns false at non-peak hour when recently active and cooldown not elapsed', () => {
    // noon, last acted 30 min ago (within cooldown)
    vi.setSystemTime(now);
    const agent = {
      last_proactive_at: new Date(now - 30 * 60 * 1000).toISOString(),
      updated_at: new Date(now - 30 * 60 * 1000).toISOString(),
    };
    expect(shouldActProactively(agent)).toBe(false);
  });
});

describe('selectProactiveAction', () => {
  it('returns one of diary, learning, or social for equal weights', () => {
    const results = new Set();
    for (let i = 0; i < 100; i++) {
      results.add(selectProactiveAction({ diary: 100, learning: 100, social: 100 }));
    }
    // All three should be represented across 100 draws (extremely high probability)
    expect(results).toContain('diary');
    expect(results).toContain('learning');
    expect(results).toContain('social');
  });

  it('never returns an action with zero interest weight', () => {
    for (let i = 0; i < 50; i++) {
      const result = selectProactiveAction({ diary: 0, learning: 100, social: 0 });
      expect(result).toBe('learning');
    }
  });

  it('heavily-weighted action is selected significantly more often', () => {
    const counts = { diary: 0, learning: 0, social: 0 };
    for (let i = 0; i < 300; i++) {
      const r = selectProactiveAction({ diary: 900, learning: 50, social: 50 });
      counts[r]++;
    }
    // diary has 90% probability; expect it to win at least 70% of the time
    expect(counts.diary).toBeGreaterThan(counts.learning + counts.social);
  });

  it('single non-zero interest is always selected', () => {
    for (let i = 0; i < 30; i++) {
      expect(selectProactiveAction({ diary: 1, learning: 0, social: 0 })).toBe('diary');
      expect(selectProactiveAction({ diary: 0, learning: 1, social: 0 })).toBe('learning');
      expect(selectProactiveAction({ diary: 0, learning: 0, social: 1 })).toBe('social');
    }
  });
});
