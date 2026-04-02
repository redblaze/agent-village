import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/llm.js', () => ({ chat: vi.fn() }));
vi.mock('../../db/agents.js', () => ({
  getAgentByApiKey: vi.fn(),
  getPrivateMemoryTexts: vi.fn().mockResolvedValue([]),
}));

import { extractOwnerMemoryFacts, extractVisitorMemorySummary } from '../../middleware/trust.js';
import { chat } from '../../services/llm.js';

describe('extractOwnerMemoryFacts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns [] when LLM returns "[]"', async () => {
    chat.mockResolvedValue('[]');
    expect(await extractOwnerMemoryFacts('hi', 'hello', [])).toEqual([]);
  });

  it('returns parsed facts array', async () => {
    chat.mockResolvedValue(JSON.stringify([
      { text: 'owner is named Alice', sensitivity: 'high' },
      { text: 'owner likes hiking', sensitivity: 'medium' },
      { text: 'owner thinks AI is interesting', sensitivity: 'low' },
    ]));
    const facts = await extractOwnerMemoryFacts('I am Alice', 'Nice to meet you Alice!', []);
    expect(facts).toHaveLength(3);
    expect(facts[0]).toEqual({ text: 'owner is named Alice', sensitivity: 'high' });
    expect(facts[1]).toEqual({ text: 'owner likes hiking', sensitivity: 'medium' });
    expect(facts[2]).toEqual({ text: 'owner thinks AI is interesting', sensitivity: 'low' });
  });

  it('defaults unrecognized sensitivity to "high"', async () => {
    chat.mockResolvedValue(JSON.stringify([
      { text: 'some fact', sensitivity: 'unknown_value' },
    ]));
    const facts = await extractOwnerMemoryFacts('msg', 'reply', []);
    expect(facts[0].sensitivity).toBe('high');
  });

  it('returns [] on JSON parse failure (malformed LLM response)', async () => {
    chat.mockResolvedValue('this is not json {{{');
    expect(await extractOwnerMemoryFacts('msg', 'reply', [])).toEqual([]);
  });

  it('filters out facts with null text field', async () => {
    chat.mockResolvedValue(JSON.stringify([
      { text: null, sensitivity: 'high' },
      { text: 'valid fact', sensitivity: 'low' },
    ]));
    const facts = await extractOwnerMemoryFacts('msg', 'reply', []);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe('valid fact');
  });

  it('filters out facts with missing text field', async () => {
    chat.mockResolvedValue(JSON.stringify([
      { sensitivity: 'high' },
      { text: 'another valid fact', sensitivity: 'medium' },
    ]));
    const facts = await extractOwnerMemoryFacts('msg', 'reply', []);
    expect(facts).toHaveLength(1);
  });

  it('passes existingTexts to LLM prompt to avoid re-extraction', async () => {
    chat.mockResolvedValue('[]');
    const existingTexts = ['owner likes coffee', 'owner has a dog'];
    await extractOwnerMemoryFacts('msg', 'reply', existingTexts);

    const [messages] = chat.mock.calls[0];
    const systemContent = messages[0].content;
    expect(systemContent).toContain('owner likes coffee');
    expect(systemContent).toContain('owner has a dog');
  });

  it('works with empty existingTexts array', async () => {
    chat.mockResolvedValue('[]');
    await expect(extractOwnerMemoryFacts('msg', 'reply', [])).resolves.toEqual([]);
  });
});

describe('extractVisitorMemorySummary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null on JSON parse failure', async () => {
    chat.mockResolvedValue('not valid json');
    expect(await extractVisitorMemorySummary('msg', 'reply', [])).toBeNull();
  });

  it('returns null when LLM returns { text:null, ownerMessage:null }', async () => {
    chat.mockResolvedValue(JSON.stringify({ text: null, ownerMessage: null, visitorName: null }));
    expect(await extractVisitorMemorySummary('hi', 'hello', [])).toBeNull();
  });

  it('returns object with text and null ownerMessage for basic summary', async () => {
    chat.mockResolvedValue(JSON.stringify({
      text: 'Visitor named Bob stopped by to chat.',
      sensitivity: 'low',
      ownerMessage: null,
      visitorName: 'Bob',
    }));
    const result = await extractVisitorMemorySummary('Hi, I am Bob', 'Nice to meet you Bob!', []);
    expect(result).toMatchObject({
      text: 'Visitor named Bob stopped by to chat.',
      sensitivity: 'low',
      ownerMessage: null,
      visitorName: 'Bob',
    });
  });

  it('returns { text:null, ownerMessage } when only owner message is present', async () => {
    chat.mockResolvedValue(JSON.stringify({
      text: null,
      sensitivity: 'medium',
      ownerMessage: 'Visitor wants a callback tomorrow.',
      visitorName: null,
    }));
    const result = await extractVisitorMemorySummary('msg', 'reply', []);
    expect(result.text).toBeNull();
    expect(result.ownerMessage).toBe('Visitor wants a callback tomorrow.');
  });

  it('captures visitorName from LLM response', async () => {
    chat.mockResolvedValue(JSON.stringify({
      text: 'Alice visited.',
      sensitivity: 'low',
      ownerMessage: null,
      visitorName: 'Alice',
    }));
    const result = await extractVisitorMemorySummary('My name is Alice', 'Hi Alice!', []);
    expect(result.visitorName).toBe('Alice');
  });

  it('defaults unrecognized sensitivity to "medium"', async () => {
    chat.mockResolvedValue(JSON.stringify({
      text: 'Some summary.',
      sensitivity: 'invalid',
      ownerMessage: null,
      visitorName: null,
    }));
    const result = await extractVisitorMemorySummary('msg', 'reply', []);
    expect(result.sensitivity).toBe('medium');
  });

  it('handles non-array priorTexts gracefully (array guard)', async () => {
    chat.mockResolvedValue(JSON.stringify({ text: 'summary', sensitivity: 'low', ownerMessage: null, visitorName: null }));
    // Passing a string instead of an array — should not throw
    await expect(extractVisitorMemorySummary('msg', 'reply', 'not an array')).resolves.toBeDefined();
  });

  it('filters null entries from priorTexts before building prompt', async () => {
    chat.mockResolvedValue(JSON.stringify({ text: 'new info', sensitivity: 'low', ownerMessage: null, visitorName: null }));
    const priorTexts = [null, 'prior summary', null];
    await extractVisitorMemorySummary('msg', 'reply', priorTexts);

    const [messages] = chat.mock.calls[0];
    const systemContent = messages[0].content;
    expect(systemContent).toContain('prior summary');
    // null entries should not appear as literal "null" in the prompt
    expect(systemContent).not.toContain('- null');
  });

  it('passes priorTexts as "already recorded" bullets in prompt', async () => {
    chat.mockResolvedValue(JSON.stringify({ text: 'new stuff', sensitivity: 'low', ownerMessage: null, visitorName: null }));
    const priorTexts = ['visitor is named Carol', 'visitor mentioned project X'];
    await extractVisitorMemorySummary('msg', 'reply', priorTexts);

    const [messages] = chat.mock.calls[0];
    const systemContent = messages[0].content;
    expect(systemContent).toContain('visitor is named Carol');
    expect(systemContent).toContain('visitor mentioned project X');
  });
});
