import { getAgentByApiKey } from '../db/agents.js';

export async function resolveTrust(req, res, next) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const agent = await getAgentByApiKey(apiKey);
      if (agent && agent.id === req.params.id) {
        req.trustLevel = 'owner';
        req.agent = agent;
        return next();
      }
    }
    req.trustLevel = 'stranger';
    next();
  } catch (err) {
    // Fall back to stranger on any unexpected error — never hang the request
    console.error('resolveTrust error:', err);
    req.trustLevel = 'stranger';
    next();
  }
}
