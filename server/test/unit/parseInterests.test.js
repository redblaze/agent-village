import { describe, it, expect, vi } from 'vitest';

// Prevent Supabase client initialization — parseInterests is a pure utility
// but lives in db/agents.js which imports the client at module load time.
vi.mock('../../db/client.js', () => ({ supabase: {} }));

import { parseInterests } from '../../db/agents.js';

const DEFAULTS = { diary: 100, learning: 100, social: 100 };

describe('parseInterests', () => {
  it('returns defaults for agent with null status', () => {
    expect(parseInterests({ status: null })).toEqual(DEFAULTS);
  });

  it('returns defaults for agent with undefined status', () => {
    expect(parseInterests({ status: undefined })).toEqual(DEFAULTS);
  });

  it('returns defaults for agent with non-JSON string status', () => {
    expect(parseInterests({ status: 'not json' })).toEqual(DEFAULTS);
  });

  it('returns defaults for agent with empty object status', () => {
    expect(parseInterests({ status: {} })).toEqual(DEFAULTS);
  });

  it('returns defaults when diary field is missing', () => {
    expect(parseInterests({ status: JSON.stringify({ learning: 50, social: 50 }) })).toEqual(DEFAULTS);
  });

  it('returns defaults when a field is the wrong type (string instead of number)', () => {
    expect(parseInterests({ status: JSON.stringify({ diary: '100', learning: 100, social: 100 }) })).toEqual(DEFAULTS);
  });

  it('returns parsed values for valid JSON string status', () => {
    const status = JSON.stringify({ diary: 200, learning: 150, social: 80 });
    expect(parseInterests({ status })).toEqual({ diary: 200, learning: 150, social: 80 });
  });

  it('returns parsed values when status is already a plain object', () => {
    expect(parseInterests({ status: { diary: 10, learning: 20, social: 30 } }))
      .toEqual({ diary: 10, learning: 20, social: 30 });
  });

  it('returned values are numbers, not strings', () => {
    const status = JSON.stringify({ diary: 5, learning: 10, social: 15 });
    const result = parseInterests({ status });
    expect(typeof result.diary).toBe('number');
    expect(typeof result.learning).toBe('number');
    expect(typeof result.social).toBe('number');
  });

  it('returns defaults when all fields are zero (object has all keys but with wrong types via toString)', () => {
    // Zero is a valid number — should parse correctly, not fall back to defaults
    expect(parseInterests({ status: { diary: 0, learning: 0, social: 0 } }))
      .toEqual({ diary: 0, learning: 0, social: 0 });
  });
});
