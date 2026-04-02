import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../config/env.js', () => ({
  config: {
    sessionMaxHistory: 20,
    sessionTtlMs: 1_800_000,
    enableLlmOutputModeration: false,
    proactiveCooldownMs: 3_600_000,
  },
}));

vi.mock('../../db/agents.js', () => ({
  createAgent: vi.fn(),
  getAllAgents: vi.fn().mockResolvedValue([]),
  getAgentById: vi.fn(),
  getAgentByApiKey: vi.fn(),
  getPrivateMemoryTexts: vi.fn().mockResolvedValue([]),
  getMemoriesForContext: vi.fn().mockResolvedValue([]),
  getVisitorMemoriesBySession: vi.fn().mockResolvedValue([]),
  getVisitorMemories: vi.fn().mockResolvedValue([]),
  insertVisitorMemory: vi.fn().mockResolvedValue(undefined),
  saveMemory: vi.fn().mockResolvedValue(undefined),
  incrementInterests: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/feed.js', () => ({
  logAgentAction: vi.fn().mockResolvedValue(undefined),
  getRecentDiaryEntries: vi.fn().mockResolvedValue([]),
  getRecentActionLogs: vi.fn().mockResolvedValue([]),
  getActionLogsWithTimestamp: vi.fn().mockResolvedValue([]),
  getDiaryEntryById: vi.fn().mockResolvedValue(null),
  getLogEntryById: vi.fn().mockResolvedValue(null),
  getActivityEventById: vi.fn().mockResolvedValue(null),
  getVisitorConversationTurns: vi.fn().mockResolvedValue([]),
  addSkill: vi.fn().mockResolvedValue(undefined),
  getAgentSkills: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/llm.js', () => ({ chat: vi.fn() }));
vi.mock('../../services/eventBus.js', () => ({ trigger: vi.fn(), respondTo: vi.fn() }));
vi.mock('../../middleware/proactivePolicy.js', () => ({
  buildPublicContext: vi.fn().mockResolvedValue('You are TestAgent.'),
  buildLogContext: vi.fn().mockResolvedValue('You are TestAgent.'),
  shouldActProactively: vi.fn().mockReturnValue(false),
  selectProactiveAction: vi.fn().mockReturnValue('diary'),
}));

import agentsRouter from '../../routes/agents.js';
import { createAgent, getAgentById, getAgentByApiKey, getAllAgents, getVisitorMemoriesBySession } from '../../db/agents.js';
import { getActionLogsWithTimestamp, getDiaryEntryById, getLogEntryById, getActivityEventById, getVisitorConversationTurns } from '../../db/feed.js';
import { chat } from '../../services/llm.js';

const AGENT_ID = 'agent-uuid-001';
const AGENT = {
  id: AGENT_ID,
  name: 'TestAgent',
  bio: 'I am a test agent.',
  visitor_bio: 'Hello, I am TestAgent.',
  api_key: 'test-api-key',
  status: null,
  updated_at: new Date().toISOString(),
  last_proactive_at: null,
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/agents', agentsRouter);
  return app;
}

describe('POST /agents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('201 + { id, name, api_key } when name is provided', async () => {
    createAgent.mockResolvedValue({ id: 'new-id', name: 'NewAgent', api_key: 'sq_abc123' });
    const res = await request(buildApp())
      .post('/agents')
      .send({ name: 'NewAgent', bio: 'A new agent' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'new-id', name: 'NewAgent', api_key: 'sq_abc123' });
  });

  it('400 when name is missing from body', async () => {
    const res = await request(buildApp())
      .post('/agents')
      .send({ bio: 'No name here' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('500 when DB createAgent throws', async () => {
    createAgent.mockRejectedValue(new Error('DB error'));
    const res = await request(buildApp())
      .post('/agents')
      .send({ name: 'Agent' });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});

describe('POST /agents/:id/message', () => {
  beforeEach(() => vi.clearAllMocks());

  it('400 when message field is missing from body', async () => {
    const res = await request(buildApp())
      .post(`/agents/${AGENT_ID}/message`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('404 when agent not found', async () => {
    getAgentByApiKey.mockResolvedValue(null);
    getAgentById.mockResolvedValue(null);
    const res = await request(buildApp())
      .post(`/agents/${AGENT_ID}/message`)
      .send({ message: 'Hello' });

    expect(res.status).toBe(404);
  });

  it('200 + { reply, sessionId } for valid stranger message', async () => {
    getAgentByApiKey.mockResolvedValue(null); // no owner key
    getAgentById.mockResolvedValue(AGENT);
    getVisitorMemoriesBySession.mockResolvedValue([]);
    chat.mockResolvedValueOnce('SAFE');         // input guard
    chat.mockResolvedValueOnce('Hello visitor!'); // main reply

    const res = await request(buildApp())
      .post(`/agents/${AGENT_ID}/message`)
      .send({ message: 'Hi there' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('reply');
    expect(res.body).toHaveProperty('sessionId');
  });

  it('200 + { reply, sessionId } for valid owner message (x-api-key header)', async () => {
    getAgentByApiKey.mockResolvedValue(AGENT);
    chat.mockResolvedValue('Hello owner!');

    const res = await request(buildApp())
      .post(`/agents/${AGENT_ID}/message`)
      .set('x-api-key', 'test-api-key')
      .send({ message: 'Hello agent' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Hello owner!');
  });

  it('500 when LLM throws', async () => {
    getAgentByApiKey.mockResolvedValue(AGENT);
    chat.mockRejectedValue(new Error('LLM unavailable'));

    const res = await request(buildApp())
      .post(`/agents/${AGENT_ID}/message`)
      .set('x-api-key', 'test-api-key')
      .send({ message: 'Hello' });

    expect(res.status).toBe(500);
  });
});

describe('GET /agents/:id/activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentByApiKey.mockResolvedValue(null);
    getAllAgents.mockResolvedValue([]);
    getVisitorMemoriesBySession.mockResolvedValue([]);
    getDiaryEntryById.mockResolvedValue(null);
    getLogEntryById.mockResolvedValue(null);
    getActivityEventById.mockResolvedValue(null);
  });

  it('403 when x-api-key is missing', async () => {
    const res = await request(buildApp())
      .get(`/agents/${AGENT_ID}/activity`);
    expect(res.status).toBe(403);
  });

  it('403 when x-api-key does not match agent', async () => {
    getAgentByApiKey.mockResolvedValue({ id: 'other-agent', api_key: 'other-key' });
    const res = await request(buildApp())
      .get(`/agents/${AGENT_ID}/activity`)
      .set('x-api-key', 'other-key');
    expect(res.status).toBe(403);
  });

  it('200 + { items: [] } when no logs exist', async () => {
    getAgentByApiKey.mockResolvedValue(AGENT);
    getActionLogsWithTimestamp.mockResolvedValue([]);

    const res = await request(buildApp())
      .get(`/agents/${AGENT_ID}/activity`)
      .set('x-api-key', 'test-api-key');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('200 with diary, learning, social, visitor_chat, owner_notification entries', async () => {
    getAgentByApiKey.mockResolvedValue(AGENT);
    const now = new Date().toISOString();
    getActionLogsWithTimestamp.mockResolvedValue([
      { id: '1', action_type: 'diary',    content: { diary_id: 'diary-1' },            created_at: now },
      { id: '2', action_type: 'learning', content: { log_id: 'log-1' },                created_at: now },
      { id: '3', action_type: 'social',   content: { activity_event_id: 'event-1' },   created_at: now },
      { id: '4', action_type: 'visitor_chat', content: { session_id: 'sess-1' },       created_at: now },
      { id: '5', action_type: 'owner_notification', content: { message: 'Hi!', visitorName: 'Bob' }, created_at: now },
    ]);
    getDiaryEntryById.mockResolvedValue('Today I wrote a diary entry about nature.');
    getLogEntryById.mockResolvedValue('I learned about distributed systems.');
    getActivityEventById.mockResolvedValue({ event_type: 'follow', recipient_id: 'agent-2', content: null });
    getVisitorMemoriesBySession.mockResolvedValue([{ text: 'visitor chat summary' }]);
    getAllAgents.mockResolvedValue([{ id: 'agent-2', name: 'OtherAgent' }]);

    const res = await request(buildApp())
      .get(`/agents/${AGENT_ID}/activity`)
      .set('x-api-key', 'test-api-key');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5);

    const types = res.body.items.map(i => i.type);
    expect(types).toContain('diary');
    expect(types).toContain('learning');
    expect(types).toContain('social');
    expect(types).toContain('visitor_chat');
    expect(types).toContain('owner_notification');
  });

  it('visitor_chat entries are deduplicated by session_id', async () => {
    getAgentByApiKey.mockResolvedValue(AGENT);
    const now = new Date().toISOString();
    getActionLogsWithTimestamp.mockResolvedValue([
      { id: '1', action_type: 'visitor_chat', content: { session_id: 'same-session' }, created_at: now },
      { id: '2', action_type: 'visitor_chat', content: { session_id: 'same-session' }, created_at: now },
      { id: '3', action_type: 'visitor_chat', content: { session_id: 'other-session' }, created_at: now },
    ]);
    getVisitorMemoriesBySession.mockResolvedValue([]);

    const res = await request(buildApp())
      .get(`/agents/${AGENT_ID}/activity`)
      .set('x-api-key', 'test-api-key');

    expect(res.status).toBe(200);
    const chatItems = res.body.items.filter(i => i.type === 'visitor_chat');
    expect(chatItems).toHaveLength(2); // deduplicated to 2 unique sessions
  });

  it('diary items include full_text', async () => {
    getAgentByApiKey.mockResolvedValue(AGENT);
    const now = new Date().toISOString();
    const diaryText = 'A long diary entry about my day in the park.';
    getActionLogsWithTimestamp.mockResolvedValue([
      { id: '1', action_type: 'diary', content: { diary_id: 'diary-1' }, created_at: now },
    ]);
    getDiaryEntryById.mockResolvedValue(diaryText);

    const res = await request(buildApp())
      .get(`/agents/${AGENT_ID}/activity`)
      .set('x-api-key', 'test-api-key');

    expect(res.body.items[0].full_text).toBe(diaryText);
  });

  it('social items include recipient_id', async () => {
    getAgentByApiKey.mockResolvedValue(AGENT);
    const now = new Date().toISOString();
    getActionLogsWithTimestamp.mockResolvedValue([
      { id: '1', action_type: 'social', content: { activity_event_id: 'ev-1' }, created_at: now },
    ]);
    getActivityEventById.mockResolvedValue({ event_type: 'like', recipient_id: 'agent-99', content: null });
    getAllAgents.mockResolvedValue([{ id: 'agent-99', name: 'PeerAgent' }]);

    const res = await request(buildApp())
      .get(`/agents/${AGENT_ID}/activity`)
      .set('x-api-key', 'test-api-key');

    expect(res.body.items[0].recipient_id).toBe('agent-99');
  });

  it('visitor_chat items include session_id', async () => {
    getAgentByApiKey.mockResolvedValue(AGENT);
    const now = new Date().toISOString();
    getActionLogsWithTimestamp.mockResolvedValue([
      { id: '1', action_type: 'visitor_chat', content: { session_id: 'my-session' }, created_at: now },
    ]);
    getVisitorMemoriesBySession.mockResolvedValue([]);

    const res = await request(buildApp())
      .get(`/agents/${AGENT_ID}/activity`)
      .set('x-api-key', 'test-api-key');

    expect(res.body.items[0].session_id).toBe('my-session');
  });
});

describe('GET /agents/:id/conversation/:sessionId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentByApiKey.mockResolvedValue(null);
  });

  it('403 when x-api-key is missing', async () => {
    const res = await request(buildApp())
      .get(`/agents/${AGENT_ID}/conversation/sess-abc`);
    expect(res.status).toBe(403);
  });

  it('403 when x-api-key does not match agent', async () => {
    getAgentByApiKey.mockResolvedValue({ id: 'other-agent' });
    const res = await request(buildApp())
      .get(`/agents/${AGENT_ID}/conversation/sess-abc`)
      .set('x-api-key', 'wrong-key');
    expect(res.status).toBe(403);
  });

  it('200 + { turns: [] } when no conversation turns found', async () => {
    getAgentByApiKey.mockResolvedValue(AGENT);
    getVisitorConversationTurns.mockResolvedValue([]);

    const res = await request(buildApp())
      .get(`/agents/${AGENT_ID}/conversation/sess-abc`)
      .set('x-api-key', 'test-api-key');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ turns: [] });
  });

  it('200 + { turns: [{ input, output, created_at }] } for existing session', async () => {
    getAgentByApiKey.mockResolvedValue(AGENT);
    const now = new Date().toISOString();
    getVisitorConversationTurns.mockResolvedValue([
      { input: 'Hello agent', output: 'Hello visitor!', created_at: now },
      { input: 'How are you?', output: 'I am doing well.', created_at: now },
    ]);

    const res = await request(buildApp())
      .get(`/agents/${AGENT_ID}/conversation/sess-abc`)
      .set('x-api-key', 'test-api-key');

    expect(res.status).toBe(200);
    expect(res.body.turns).toHaveLength(2);
    expect(res.body.turns[0]).toMatchObject({ input: 'Hello agent', output: 'Hello visitor!' });
  });
});
