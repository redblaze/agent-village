import express from 'express';
import { createAgent } from '../db/agents.js';   // getAgentById removed — handled in resolveContext
import { respondToMessage } from '../services/agentService.js';
import { resolveTrust } from '../middleware/trust.js';
import { resolveContext } from '../middleware/chatContext.js';

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

export default router;
