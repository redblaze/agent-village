import express from 'express';
const router = express.Router();

// POST /chat/token — optional Stream Chat JWT endpoint
// Implement if wiring up the DM tab; requires stream-chat npm package
router.post('/token', async (req, res) => {
  res.status(501).json({ error: 'Stream Chat not configured' });
});

export default router;
