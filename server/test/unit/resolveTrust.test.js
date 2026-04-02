import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/agents.js', () => ({
  getAgentByApiKey: vi.fn(),
  getPrivateMemoryTexts: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../services/llm.js', () => ({ chat: vi.fn() }));

import { resolveTrust } from '../../middleware/trust.js';
import { getAgentByApiKey } from '../../db/agents.js';

const AGENT_ID = 'agent-uuid-123';
const AGENT = { id: AGENT_ID, name: 'TestAgent', api_key: 'valid-key' };

function makeReq(overrides = {}) {
  return {
    headers: {},
    params: { id: AGENT_ID },
    ...overrides,
  };
}

function makeRes() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() };
}

describe('resolveTrust middleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets trustLevel=owner and req.agent when x-api-key matches agent with matching id', async () => {
    getAgentByApiKey.mockResolvedValue(AGENT);
    const req = makeReq({ headers: { 'x-api-key': 'valid-key' } });
    const next = vi.fn();
    await resolveTrust(req, makeRes(), next);

    expect(req.trustLevel).toBe('owner');
    expect(req.agent).toBe(AGENT);
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets trustLevel=stranger when no x-api-key header', async () => {
    const req = makeReq();
    const next = vi.fn();
    await resolveTrust(req, makeRes(), next);

    expect(req.trustLevel).toBe('stranger');
    expect(getAgentByApiKey).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets trustLevel=stranger when API key matches agent but agent.id !== req.params.id', async () => {
    getAgentByApiKey.mockResolvedValue({ id: 'different-agent-id', name: 'Other' });
    const req = makeReq({ headers: { 'x-api-key': 'other-agent-key' } });
    const next = vi.fn();
    await resolveTrust(req, makeRes(), next);

    expect(req.trustLevel).toBe('stranger');
    expect(req.agent).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets trustLevel=stranger when getAgentByApiKey returns null', async () => {
    getAgentByApiKey.mockResolvedValue(null);
    const req = makeReq({ headers: { 'x-api-key': 'unknown-key' } });
    const next = vi.fn();
    await resolveTrust(req, makeRes(), next);

    expect(req.trustLevel).toBe('stranger');
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets trustLevel=stranger (fails open) when getAgentByApiKey throws', async () => {
    getAgentByApiKey.mockRejectedValue(new Error('DB error'));
    const req = makeReq({ headers: { 'x-api-key': 'any-key' } });
    const next = vi.fn();
    await resolveTrust(req, makeRes(), next);

    expect(req.trustLevel).toBe('stranger');
    expect(next).toHaveBeenCalledOnce();
  });

  it('calls next() in all cases — never hangs the request', async () => {
    const scenarios = [
      makeReq(),
      makeReq({ headers: { 'x-api-key': 'valid-key' } }),
    ];
    getAgentByApiKey.mockResolvedValue(AGENT);

    for (const req of scenarios) {
      const next = vi.fn();
      await resolveTrust(req, makeRes(), next);
      expect(next).toHaveBeenCalledOnce();
    }
  });
});
