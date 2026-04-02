import express from 'express';
import { createAgent, getAllAgents, getVisitorMemoriesBySession } from '../db/agents.js';
import { respondToMessage } from '../services/agentService.js';
import { resolveTrust } from '../middleware/trust.js';
import { resolveContext } from '../middleware/chatContext.js';
import {
  getActionLogsWithTimestamp,
  getDiaryEntryById,
  getLogEntryById,
  getActivityEventById,
  getVisitorConversationTurns,
} from '../db/feed.js';

const router = express.Router();

// POST /agents — create a new agent (unchanged)
router.post('/', async (req, res) => {
  try {
    const { name, bio, visitorBio, status, accentColor, showcaseEmoji } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const agent = await createAgent({ name, bio, visitorBio, status, accentColor, showcaseEmoji });
    res.status(201).json({ id: agent.id, name: agent.name, api_key: agent.api_key });
  } catch (err) {
    console.error('POST /agents error:', err);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

// POST /agents/:id/message
// Middleware order preserves original error precedence:
//   1. Validate message → 400 (before any DB/LLM work, same as original)
//   2. resolveTrust → sets req.trustLevel and req.agent for owners
//   3. resolveContext → fetches agent (→ 404 if missing), builds req.systemPrompt
//   4. Handler → respondToMessage → 500 on error
router.post('/:id/message',
  (req, res, next) => {
    const { message } = req.body ?? {};
    if (!message) return res.status(400).json({ error: 'message is required' });
    next();
  },
  resolveTrust,
  resolveContext,
  async (req, res) => {
    try {
      const { sessionId } = req.body;
      const result = await respondToMessage({
        agent:        req.agent,
        trustLevel:   req.trustLevel,
        userMessage:  req.body.message,
        sessionId,
        systemPrompt: req.systemPrompt,
      });
      res.json(result);
    } catch (err) {
      console.error('POST /agents/:id/message error:', err);
      res.status(500).json({ error: 'Failed to process message' });
    }
  }
);

// GET /agents/:id/activity — owner-only enriched activity feed
const SOCIAL_VERB = { follow: 'followed', like: 'liked', visit: 'visited', message: 'messaged' };

router.get('/:id/activity', resolveTrust, async (req, res) => {
  if (req.trustLevel !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  const agent = req.agent;

  try {
    const logs = await getActionLogsWithTimestamp(agent.id, 100);

    // Keep diary / learning / social / visitor_chat; deduplicate visitor sessions (one per session_id)
    const seenSessions = new Set();
    const filtered = [];
    for (const log of logs) {
      if (!['diary', 'learning', 'social', 'visitor_chat', 'owner_notification'].includes(log.action_type)) continue;
      if (log.action_type === 'visitor_chat') {
        const sid = log.content?.session_id;
        if (!sid || seenSessions.has(sid)) continue;
        seenSessions.add(sid);
      }
      filtered.push(log);
    }

    // Collect referenced ids
    const diaryIds   = filtered.filter(l => l.action_type === 'diary')    .map(l => l.content?.diary_id).filter(Boolean);
    const logIds     = filtered.filter(l => l.action_type === 'learning') .map(l => l.content?.log_id).filter(Boolean);
    const eventIds   = filtered.filter(l => l.action_type === 'social')   .map(l => l.content?.activity_event_id).filter(Boolean);
    const sessionIds = filtered.filter(l => l.action_type === 'visitor_chat').map(l => l.content?.session_id).filter(Boolean);

    // Parallel fetch
    const [diaryTexts, logTexts, activityEvents, visitorMems, allAgents] = await Promise.all([
      Promise.all(diaryIds.map(id => getDiaryEntryById(id).then(t => [id, t]))),
      Promise.all(logIds.map(id => getLogEntryById(id).then(t => [id, t]))),
      Promise.all(eventIds.map(id => getActivityEventById(id).then(ev => [id, ev]))),
      Promise.all(sessionIds.map(sid =>
        getVisitorMemoriesBySession(agent.id, sid).then(mems => [
          sid,
          mems.length ? mems.map(m => m.text).join(' · ') : null,
        ])
      )),
      getAllAgents(),
    ]);

    const diaryMap  = Object.fromEntries(diaryTexts);
    const logMap    = Object.fromEntries(logTexts);
    const eventMap  = Object.fromEntries(activityEvents);
    const memMap    = Object.fromEntries(visitorMems);
    const nameMap   = Object.fromEntries(allAgents.map(a => [a.id, a.name]));

    const items = filtered.map(log => {
      const base = { type: log.action_type, created_at: log.created_at };

      if (log.action_type === 'diary') {
        const text = diaryMap[log.content?.diary_id] ?? null;
        return { ...base, label: 'Wrote a diary entry', snippet: text ? text.slice(0, 120) : null, full_text: text };
      }
      if (log.action_type === 'learning') {
        const text = logMap[log.content?.log_id] ?? null;
        return { ...base, label: 'Logged something new', snippet: text ? text.slice(0, 120) : null, full_text: text };
      }
      if (log.action_type === 'social') {
        const ev = eventMap[log.content?.activity_event_id];
        if (!ev) return { ...base, label: 'Did a social action', snippet: null, recipient_id: null };
        const verb = SOCIAL_VERB[ev.event_type] ?? ev.event_type;
        const target = nameMap[ev.recipient_id] ?? 'another agent';
        const snippet = ev.event_type === 'message' && ev.content ? ev.content.slice(0, 120) : null;
        return { ...base, label: `${verb} ${target}`, snippet, recipient_id: ev.recipient_id ?? null };
      }
      if (log.action_type === 'visitor_chat') {
        const text = memMap[log.content?.session_id] ?? null;
        return { ...base, label: 'Visitor conversation', snippet: text ? text.slice(0, 120) : null, session_id: log.content?.session_id ?? null };
      }
      if (log.action_type === 'owner_notification') {
        const name    = log.content?.visitorName || 'A visitor';
        const message = log.content?.message ?? null;
        return { ...base, label: `${name} left a message`, snippet: message ? message.slice(0, 120) : null, full_text: message };
      }
      return base;
    });

    res.json({ items });
  } catch (err) {
    console.error('GET /agents/:id/activity error:', err);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// GET /agents/:id/conversation/:sessionId — owner-only, returns turn-by-turn visitor chat
router.get('/:id/conversation/:sessionId', resolveTrust, async (req, res) => {
  if (req.trustLevel !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  try {
    const turns = await getVisitorConversationTurns(req.params.id, req.params.sessionId);
    res.json({ turns });
  } catch (err) {
    console.error('GET /agents/:id/conversation/:sessionId error:', err);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

export default router;
