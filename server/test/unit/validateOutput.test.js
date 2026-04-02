import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/llm.js', () => ({ chat: vi.fn() }));
vi.mock('../../db/agents.js', () => ({
  getAgentByApiKey: vi.fn(),
  getPrivateMemoryTexts: vi.fn(),
}));

import { validateOutput } from '../../middleware/trust.js';
import { chat } from '../../services/llm.js';
import { getPrivateMemoryTexts } from '../../db/agents.js';

// Helper to temporarily set enableLlmOutputModeration=true for the duration of a test.
// The config module is already loaded, so we manipulate its value directly.
import { config } from '../../config/env.js';

const SAFE_REFUSAL = "I prefer to keep my owner's personal information private.";
const AGENT = { id: 'agent-1', name: 'TestAgent' };

describe('validateOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.enableLlmOutputModeration = false; // default state
    getPrivateMemoryTexts.mockResolvedValue([]);
  });

  afterEach(() => {
    config.enableLlmOutputModeration = false;
  });

  it('returns reply unchanged when trustLevel=owner', async () => {
    const reply = 'Here is my private diary entry.';
    expect(await validateOutput(reply, 'owner', AGENT)).toBe(reply);
    expect(chat).not.toHaveBeenCalled();
  });

  it('returns empty string when reply is null', async () => {
    expect(await validateOutput(null, 'stranger', AGENT)).toBe('');
  });

  it('returns empty string when reply is empty string', async () => {
    expect(await validateOutput('', 'stranger', AGENT)).toBe('');
  });

  it('returns reply unchanged when enableLlmOutputModeration is false (default)', async () => {
    const reply = 'Hello, visitor!';
    expect(await validateOutput(reply, 'stranger', AGENT)).toBe(reply);
    expect(chat).not.toHaveBeenCalled();
  });

  describe('with enableLlmOutputModeration=true', () => {
    beforeEach(() => {
      config.enableLlmOutputModeration = true;
    });

    it('returns reply when LLM moderation says SAFE', async () => {
      getPrivateMemoryTexts.mockResolvedValue([]);
      chat.mockResolvedValue('SAFE');
      const reply = 'I enjoy painting landscapes.';
      expect(await validateOutput(reply, 'stranger', AGENT)).toBe(reply);
    });

    it('returns SAFE_REFUSAL when LLM moderation says UNSAFE', async () => {
      getPrivateMemoryTexts.mockResolvedValue([]);
      chat.mockResolvedValue('UNSAFE');
      expect(await validateOutput('My owner is John at 123 Main St.', 'stranger', AGENT))
        .toBe(SAFE_REFUSAL);
    });

    it('returns reply (fail open) when LLM moderation throws', async () => {
      getPrivateMemoryTexts.mockResolvedValue([]);
      chat.mockRejectedValue(new Error('LLM down'));
      const reply = 'Some reply text.';
      expect(await validateOutput(reply, 'stranger', AGENT)).toBe(reply);
    });

    it('returns reply (fail open) when LLM returns unrecognized response', async () => {
      getPrivateMemoryTexts.mockResolvedValue([]);
      chat.mockResolvedValue('MAYBE');
      const reply = 'Some reply text.';
      expect(await validateOutput(reply, 'stranger', AGENT)).toBe(reply);
    });

    it('fetches private memory texts and passes them to LLM prompt', async () => {
      const privateTexts = ['owner lives in New York', 'owner works at Tech Corp'];
      getPrivateMemoryTexts.mockResolvedValue(privateTexts);
      chat.mockResolvedValue('SAFE');

      await validateOutput('Hello!', 'stranger', AGENT);

      expect(getPrivateMemoryTexts).toHaveBeenCalledWith(AGENT.id);
      // The private texts should appear in the system prompt passed to chat()
      const [messages] = chat.mock.calls[0];
      const systemContent = messages[0].content;
      expect(systemContent).toContain('owner lives in New York');
      expect(systemContent).toContain('owner works at Tech Corp');
    });
  });
});
