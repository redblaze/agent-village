import express from 'express';
import { createAgent, getAgentById } from '../db/agents.js';
import { respondToMessage } from '../services/agentService.js';
import { resolveTrust } from '../middleware/trust.js';

const router = express.Router();

// POST /agents — create a new agent
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
router.post('/:id/message', resolveTrust, async (req, res) => {
  try {
    const { message, sessionId } = req.body ?? {};
    if (!message) return res.status(400).json({ error: 'message is required' });

    // For strangers, req.agent is not set by trust middleware — fetch it here
    const agent = req.agent ?? await getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const result = await respondToMessage({
      agent,
      trustLevel: req.trustLevel,
      userMessage: message,
      sessionId,
    });
    res.json(result);
  } catch (err) {
    console.error('POST /agents/:id/message error:', err);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

export default router;
