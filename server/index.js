import express from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import agentRoutes from './routes/agents.js';
import chatRoutes from './routes/chat.js';
import { startScheduler } from './scheduler/index.js';

// Process-level safety net — catches any rejection that slips through per-function handlers
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

const app = express();
app.use(cors());           // Allow browser requests (e.g. /chat/token from index.html)
app.use(express.json());
app.use('/agents', agentRoutes);
app.use('/chat', chatRoutes);

// Express 4 catch-all error handler — catches any error passed via next(err)
app.use((err, req, res, _next) => {
  console.error('Express error handler:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
  startScheduler(config.schedulerIntervalMs);
});
