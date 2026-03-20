import { getAllAgents } from '../db/agents.js';
import { shouldActProactively, runProactiveBehavior } from '../services/proactive.js';
import { cleanExpiredSessions } from '../services/session.js';

export function startScheduler(intervalMs) {
  console.log(`Scheduler started — interval: ${intervalMs}ms`);
  setInterval(async () => {
    try {
      cleanExpiredSessions();
      const agents = await getAllAgents();
      for (const agent of agents) {
        if (shouldActProactively(agent)) {
          await runProactiveBehavior(agent).catch(err =>
            console.error(`Proactive error for agent ${agent.id}:`, err)
          );
        }
      }
    } catch (err) {
      // Log and swallow — scheduler must never crash the process
      console.error('Scheduler tick error:', err);
    }
  }, intervalMs);
}
