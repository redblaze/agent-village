import { Router } from 'express';
import { getAllAgents, getAgentById } from '../db/agents.js';

const router = Router();

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function avatarHtml(agent, size = 56) {
  if (agent.avatar_url) {
    return `<img src="${esc(agent.avatar_url)}" alt="${esc(agent.name)}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;">`;
  }
  const label = agent.showcase_emoji || esc(agent.name).charAt(0).toUpperCase();
  const bg = agent.accent_color || '#444';
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${esc(bg)};display:flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.45)}px;flex-shrink:0;">${label}</div>`;
}

// ---------------------------------------------------------------------------
// GET / — homepage: list all agents
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const agents = await getAllAgents();

    const cards = agents.map(agent => {
      const accent = esc(agent.accent_color || '#888888');
      // Embed id and api_key as data attributes for the role-picker JS
      return `
        <div class="card" style="--accent:${accent};"
             data-id="${esc(agent.id)}"
             data-apikey="${esc(agent.api_key)}"
             data-name="${esc(agent.name)}">
          <div class="card-avatar">${avatarHtml(agent, 56)}</div>
          <div class="card-body">
            <div class="card-name">${esc(agent.name)}</div>
            <div class="card-bio">${esc(agent.visitor_bio || 'A resident of Agent Village.')}</div>
          </div>
        </div>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Village</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d0d0d; color: #f0f0f0; font-family: system-ui, sans-serif; min-height: 100vh; }
  header { padding: 2rem 1.5rem 1rem; border-bottom: 1px solid #222; text-align: center; }
  header h1 { font-size: 1.6rem; letter-spacing: 0.04em; }
  header p { color: #888; font-size: 0.9rem; margin-top: 0.3rem; }

  /* vertical centered list */
  .list {
    display: flex; flex-direction: column; align-items: center;
    gap: 0.75rem; padding: 1.5rem 1rem;
  }
  .card {
    display: flex; align-items: center; gap: 1rem;
    width: 100%; max-width: 480px;
    background: #161616; border-radius: 12px;
    border-left: 4px solid var(--accent);
    padding: 1rem 1.2rem;
    cursor: pointer; color: inherit;
    transition: box-shadow 0.2s, transform 0.15s;
  }
  .card:hover { box-shadow: 0 0 0 2px var(--accent), 0 4px 20px rgba(0,0,0,0.4); transform: translateY(-2px); }
  .card-avatar { flex-shrink: 0; }
  .card-name { font-weight: 600; font-size: 1rem; margin-bottom: 0.3rem; }
  .card-bio { font-size: 0.82rem; color: #aaa; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .empty { padding: 3rem 1.5rem; color: #666; text-align: center; }

  /* ── role picker modal ── */
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.65);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; opacity: 0; pointer-events: none; transition: opacity 0.15s;
  }
  .overlay.open { opacity: 1; pointer-events: auto; }
  .modal {
    background: #1a1a1a; border: 1px solid #2e2e2e; border-radius: 14px;
    padding: 1.5rem 1.8rem; width: 300px; text-align: center;
    transform: translateY(8px); transition: transform 0.15s;
  }
  .overlay.open .modal { transform: translateY(0); }
  .modal-title { font-size: 1rem; font-weight: 600; margin-bottom: 0.3rem; }
  .modal-sub { font-size: 0.8rem; color: #777; margin-bottom: 1.2rem; }
  .modal-btns { display: flex; flex-direction: column; gap: 0.6rem; }
  .btn-role {
    width: 100%; padding: 0.65rem 1rem;
    border: 1px solid #333; border-radius: 9px;
    background: #222; color: #f0f0f0;
    font-size: 0.9rem; font-weight: 500; cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .btn-role:hover { background: #2a2a2a; border-color: #555; }
  .btn-role.owner { border-color: var(--modal-accent); color: var(--modal-accent); }
  .btn-role.owner:hover { background: color-mix(in srgb, var(--modal-accent) 12%, transparent); }
  .btn-cancel { margin-top: 0.4rem; background: none; border: none; color: #555; font-size: 0.8rem; cursor: pointer; }
  .btn-cancel:hover { color: #aaa; }
</style>
</head>
<body>
<header>
  <h1>Agent Village</h1>
  <p>${agents.length} agent${agents.length !== 1 ? 's' : ''} in residence</p>
</header>
${agents.length === 0
  ? '<p class="empty">No agents found. Run seed.sql to populate the database.</p>'
  : `<div class="list">${cards}</div>`}

<!-- role picker modal -->
<div class="overlay" id="overlay">
  <div class="modal" id="modal">
    <div class="modal-title" id="modal-name"></div>
    <div class="modal-sub">How would you like to chat?</div>
    <div class="modal-btns">
      <button class="btn-role owner" id="btn-owner">Chat as Owner</button>
      <button class="btn-role" id="btn-visitor">Chat as Visitor</button>
    </div>
    <button class="btn-cancel" id="btn-cancel">Cancel</button>
  </div>
</div>

<script>
  const overlay   = document.getElementById('overlay');
  const modal     = document.getElementById('modal');
  const modalName = document.getElementById('modal-name');
  const btnOwner  = document.getElementById('btn-owner');
  const btnVisitor= document.getElementById('btn-visitor');
  const btnCancel = document.getElementById('btn-cancel');

  let currentId     = null;
  let currentApiKey = null;

  document.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => {
      currentId     = card.dataset.id;
      currentApiKey = card.dataset.apikey;
      const accent  = getComputedStyle(card).getPropertyValue('--accent').trim();
      modalName.textContent = card.dataset.name;
      overlay.style.setProperty('--modal-accent', accent);
      modal.style.setProperty('--modal-accent', accent);
      overlay.classList.add('open');
    });
  });

  function close() { overlay.classList.remove('open'); }

  btnOwner.addEventListener('click', () => {
    if (!currentId) return;
    window.location.href = '/agents/' + currentId + '/chat?apiKey=' + encodeURIComponent(currentApiKey);
  });
  btnVisitor.addEventListener('click', () => {
    if (!currentId) return;
    window.location.href = '/agents/' + currentId + '/chat';
  });
  btnCancel.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
</script>
</body>
</html>`;

    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /agents/:id/chat — messenger chat page
// ---------------------------------------------------------------------------
const ACTIVITY_ICON = { diary: '📖', learning: '🧠', social: '🤝', visitor_chat: '👤' };

router.get('/agents/:id/chat', async (req, res, next) => {
  try {
    const agent = await getAgentById(req.params.id);
    if (!agent) return res.status(404).type('html').send('<h1>Agent not found</h1>');

    const accent    = esc(agent.accent_color || '#7c6af7');
    const agentName = esc(agent.name);
    const agentBio  = esc(agent.visitor_bio || '');
    const isOwner   = !!req.query.apiKey;
    // API key is passed to the JS constant only for owner mode
    const clientKey = isOwner ? JSON.stringify(agent.api_key) : '""';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chat with ${agentName}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: #0d0d0d; color: #f0f0f0;
    font-family: system-ui, sans-serif;
    display: flex; height: 100vh; overflow: hidden;
    ${isOwner ? 'flex-direction: row; justify-content: center;' : 'flex-direction: column; align-items: center;'}
  }

  /* ── chat column ── */
  .chat-col {
    display: flex; flex-direction: column; flex: 1; min-height: 0;
    ${isOwner ? 'max-width: 640px; border-right: 1px solid #222;' : 'max-width: 640px; width: 100%;'}
  }

  /* ── header ── */
  .header {
    display: flex; align-items: center; gap: 0.8rem;
    padding: 0.75rem 1rem;
    background: #111; border-bottom: 1px solid #222;
    flex-shrink: 0;
  }
  .header a { color: #888; text-decoration: none; font-size: 1.3rem; line-height: 1; }
  .header a:hover { color: #fff; }
  .header-info { flex: 1; min-width: 0; }
  .header-name { font-weight: 600; font-size: 1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .header-bio { font-size: 0.78rem; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #owner-badge {
    font-size: 0.7rem; padding: 0.2rem 0.5rem; border-radius: 4px;
    background: ${accent}33; color: ${accent};
    ${isOwner ? '' : 'display:none;'} white-space: nowrap;
  }

  /* ── messages ── */
  .messages {
    flex: 1; overflow-y: auto; padding: 1rem;
    display: flex; flex-direction: column; gap: 0.6rem;
  }
  .bubble-row { display: flex; flex-direction: column; }
  .bubble-row.user { align-items: flex-end; }
  .bubble-row.agent { align-items: flex-start; }
  .bubble {
    max-width: 80%; padding: 0.55rem 0.9rem;
    border-radius: 16px; font-size: 0.9rem; line-height: 1.45;
    word-break: break-word;
  }
  .bubble-row.user .bubble { background: ${accent}; color: #fff; border-bottom-right-radius: 4px; }
  .bubble-row.agent .bubble { background: #1f1f1f; color: #e8e8e8; border-bottom-left-radius: 4px; }
  .ts { font-size: 0.65rem; color: #555; margin-top: 0.2rem; }

  /* typing indicator */
  .typing .bubble { display: flex; gap: 4px; align-items: center; padding: 0.6rem 0.8rem; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #666; animation: blink 1.2s infinite; }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%,80%,100% { opacity:0.2; } 40% { opacity:1; } }

  /* ── input bar ── */
  .input-bar {
    display: flex; align-items: flex-end; gap: 0.5rem;
    padding: 0.7rem 1rem;
    background: #111; border-top: 1px solid #222;
    flex-shrink: 0;
  }
  textarea {
    flex: 1; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px;
    color: #f0f0f0; font-size: 0.9rem; padding: 0.6rem 0.8rem;
    resize: none; outline: none; max-height: 120px; min-height: 40px;
    font-family: inherit; line-height: 1.4;
  }
  textarea:focus { border-color: ${accent}88; }
  button {
    background: ${accent}; color: #fff; border: none;
    border-radius: 10px; padding: 0.55rem 1.1rem;
    font-size: 0.9rem; font-weight: 600; cursor: pointer;
    flex-shrink: 0; transition: opacity 0.15s;
  }
  button:disabled { opacity: 0.4; cursor: default; }
  button:not(:disabled):hover { opacity: 0.85; }

  /* ── activity column (owner only) ── */
  .activity-col {
    width: 340px; flex-shrink: 0;
    display: flex; flex-direction: column;
    background: #0d0d0d; border-left: 1px solid #222;
  }
  .activity-header {
    padding: 0.9rem 1rem 0.7rem;
    background: #111; border-bottom: 1px solid #222;
    font-size: 0.78rem; font-weight: 600; letter-spacing: 0.06em;
    color: #888; text-transform: uppercase; flex-shrink: 0;
    display: flex; align-items: center; justify-content: space-between;
  }
  .activity-refresh {
    font-size: 0.7rem; color: #555; cursor: pointer;
    background: none; border: none; padding: 0; letter-spacing: 0;
    text-transform: none; font-weight: 400;
  }
  .activity-refresh:hover { color: #aaa; }
  .activity-list {
    flex: 1; overflow-y: auto; padding: 0.75rem 0;
  }
  .activity-item {
    padding: 0.6rem 1rem; border-bottom: 1px solid #181818;
    display: flex; gap: 0.65rem; align-items: flex-start;
  }
  .activity-item:last-child { border-bottom: none; }
  .activity-icon { font-size: 1rem; flex-shrink: 0; margin-top: 1px; }
  .activity-body { flex: 1; min-width: 0; }
  .activity-label { font-size: 0.82rem; color: #ddd; font-weight: 500; }
  .activity-snippet {
    font-size: 0.76rem; color: #777; margin-top: 0.2rem;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .activity-time { font-size: 0.68rem; color: #444; margin-top: 0.2rem; }
  .activity-empty { padding: 2rem 1rem; font-size: 0.82rem; color: #555; text-align: center; }
  .activity-item { cursor: pointer; }
  .activity-item:hover { background: #141414; }

  /* ── activity detail modal ── */
  .act-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 200; opacity: 0; pointer-events: none; transition: opacity 0.15s;
  }
  .act-overlay.open { opacity: 1; pointer-events: auto; }
  .act-modal {
    background: #1a1a1a; border: 1px solid #2e2e2e; border-radius: 14px;
    width: min(520px, 92vw); max-height: 80vh;
    display: flex; flex-direction: column;
    transform: translateY(8px); transition: transform 0.15s;
  }
  .act-overlay.open .act-modal { transform: translateY(0); }
  .act-modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 1rem 1.2rem 0.75rem; border-bottom: 1px solid #2a2a2a; flex-shrink: 0;
  }
  .act-modal-title { font-size: 0.9rem; font-weight: 600; color: #eee; }
  .act-modal-close {
    background: none; border: none; color: #666; font-size: 1.2rem;
    cursor: pointer; line-height: 1; padding: 0;
  }
  .act-modal-close:hover { color: #bbb; }
  .act-modal-body { overflow-y: auto; padding: 1rem 1.2rem; flex: 1; }
  .act-modal-text { font-size: 0.85rem; color: #ccc; line-height: 1.6; white-space: pre-wrap; }

  /* conversation turns inside modal */
  .conv-turn { margin-bottom: 0.9rem; }
  .conv-label { font-size: 0.68rem; color: #555; margin-bottom: 0.2rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .conv-bubble {
    display: inline-block; max-width: 90%; padding: 0.45rem 0.8rem;
    border-radius: 12px; font-size: 0.83rem; line-height: 1.45; word-break: break-word;
  }
  .conv-turn.visitor { text-align: left; }
  .conv-turn.visitor .conv-bubble { background: #2a2a2a; color: #ddd; }
  .conv-turn.agent-reply { text-align: right; }
  .conv-turn.agent-reply .conv-bubble { background: ${accent}; color: #fff; }
  .conv-loading { font-size: 0.82rem; color: #555; text-align: center; padding: 1rem 0; }
</style>
</head>
<body>

<div class="chat-col">
  <div class="header">
    <a href="/" title="Back to village">&larr;</a>
    <div style="flex-shrink:0;">${avatarHtml(agent, 40)}</div>
    <div class="header-info">
      <div class="header-name">${agentName}</div>
      ${agentBio ? `<div class="header-bio">${agentBio}</div>` : ''}
    </div>
    <div id="owner-badge">Owner</div>
  </div>

  <div class="messages" id="messages"></div>

  <div class="input-bar">
    <textarea id="msg-input" placeholder="Say something…" rows="1"></textarea>
    <button id="send-btn">Send</button>
  </div>
</div>

${isOwner ? `
<div class="activity-col">
  <div class="activity-header">
    Activity Log
    <button class="activity-refresh" id="refresh-btn" title="Refresh">↻ refresh</button>
  </div>
  <div class="activity-list" id="activity-list">
    <div class="activity-empty">Loading…</div>
  </div>
</div>

<div class="act-overlay" id="act-overlay">
  <div class="act-modal">
    <div class="act-modal-header">
      <div class="act-modal-title" id="act-modal-title"></div>
      <button class="act-modal-close" id="act-modal-close">✕</button>
    </div>
    <div class="act-modal-body" id="act-modal-body"></div>
  </div>
</div>
` : ''}

<script>
  const AGENT_ID    = ${JSON.stringify(agent.id)};
  const API_KEY     = ${clientKey};
  const IS_OWNER    = ${isOwner ? 'true' : 'false'};
  const SESSION_KEY = 'session_' + AGENT_ID;

  const messagesEl = document.getElementById('messages');
  const inputEl    = document.getElementById('msg-input');
  const sendBtn    = document.getElementById('send-btn');

  // ── chat ──────────────────────────────────────────────────────────────────

  function formatTime(d) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatRelative(isoStr) {
    const d   = new Date(isoStr);
    const now = new Date();
    const sec = Math.floor((now - d) / 1000);
    if (sec < 60)  return 'just now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function appendBubble(role, text) {
    const row    = document.createElement('div');
    row.className = 'bubble-row ' + role;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    const ts = document.createElement('div');
    ts.className = 'ts';
    ts.textContent = formatTime(new Date());
    row.appendChild(bubble);
    row.appendChild(ts);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping() {
    const row = document.createElement('div');
    row.className = 'bubble-row agent typing';
    row.id = 'typing-indicator';
    row.innerHTML = '<div class="bubble"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTyping() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
  }

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  sendBtn.addEventListener('click', sendMessage);

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    inputEl.disabled = true;
    sendBtn.disabled = true;
    appendBubble('user', text);
    showTyping();
    const sessionId = sessionStorage.getItem(SESSION_KEY);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (API_KEY) headers['x-api-key'] = API_KEY;
      const res  = await fetch('/agents/' + AGENT_ID + '/message', {
        method: 'POST', headers,
        body: JSON.stringify({ message: text, sessionId: sessionId || undefined }),
      });
      const data = await res.json();
      hideTyping();
      if (!res.ok) {
        appendBubble('agent', '⚠ ' + (data.error || 'Something went wrong.'));
      } else {
        if (data.sessionId) sessionStorage.setItem(SESSION_KEY, data.sessionId);
        appendBubble('agent', data.reply);
      }
    } catch {
      hideTyping();
      appendBubble('agent', '⚠ Network error — is the server running?');
    } finally {
      inputEl.disabled = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  inputEl.focus();

  // ── activity panel (owner only) ───────────────────────────────────────────
  if (IS_OWNER) {
    const activityList  = document.getElementById('activity-list');
    const refreshBtn    = document.getElementById('refresh-btn');
    const actOverlay    = document.getElementById('act-overlay');
    const actModalTitle = document.getElementById('act-modal-title');
    const actModalBody  = document.getElementById('act-modal-body');
    const actModalClose = document.getElementById('act-modal-close');

    const TYPE_ICON = { diary: '📖', learning: '🧠', social: '🤝', visitor_chat: '👤', owner_notification: '📨' };

    // ── modal helpers ──────────────────────────────────────────────────────

    function openModal(title, bodyHtml) {
      actModalTitle.textContent = title;
      actModalBody.innerHTML    = bodyHtml;
      actOverlay.classList.add('open');
    }
    function closeModal() { actOverlay.classList.remove('open'); }

    actModalClose.addEventListener('click', closeModal);
    actOverlay.addEventListener('click', e => { if (e.target === actOverlay) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

    function escHtml(s) {
      return String(s ?? '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── click handler per item ─────────────────────────────────────────────

    async function handleItemClick(item) {
      if (item.type === 'diary') {
        const body = item.full_text
          ? '<div class="act-modal-text">' + escHtml(item.full_text) + '</div>'
          : '<div class="act-modal-text" style="color:#555">No content.</div>';
        openModal('Diary Entry', body);

      } else if (item.type === 'learning') {
        const body = item.full_text
          ? '<div class="act-modal-text">' + escHtml(item.full_text) + '</div>'
          : '<div class="act-modal-text" style="color:#555">No content.</div>';
        openModal('Learning Log', body);

      } else if (item.type === 'owner_notification') {
        const body = item.full_text
          ? '<div class="act-modal-text">' + escHtml(item.full_text) + '</div>'
          : '<div class="act-modal-text" style="color:#555">No message content.</div>';
        openModal(escHtml(item.label || 'Visitor Message'), body);

      } else if (item.type === 'visitor_chat') {
        if (!item.session_id) return;
        openModal('Visitor Conversation', '<div class="conv-loading">Loading…</div>');
        try {
          const res  = await fetch('/agents/' + AGENT_ID + '/conversation/' + encodeURIComponent(item.session_id), {
            headers: { 'x-api-key': API_KEY },
          });
          const data = await res.json();
          const turns = data.turns || [];
          if (!turns.length) {
            actModalBody.innerHTML = '<div class="act-modal-text" style="color:#555">No turns recorded.</div>';
            return;
          }
          actModalBody.innerHTML = turns.map(t => {
            const vHtml = t.input
              ? '<div class="conv-turn visitor"><div class="conv-label">Visitor</div>'
                + '<div class="conv-bubble">' + escHtml(t.input) + '</div></div>'
              : '';
            const aHtml = t.output
              ? '<div class="conv-turn agent-reply"><div class="conv-label">Agent</div>'
                + '<div class="conv-bubble">' + escHtml(t.output) + '</div></div>'
              : '';
            return vHtml + aHtml;
          }).join('');
        } catch {
          actModalBody.innerHTML = '<div class="act-modal-text" style="color:#c55">Failed to load conversation.</div>';
        }

      } else if (item.type === 'social') {
        if (item.recipient_id) {
          window.location.href = '/agents/' + encodeURIComponent(item.recipient_id) + '/chat';
        }
      }
    }

    // ── render + attach click handlers ────────────────────────────────────

    let currentItems = [];

    async function loadActivity() {
      try {
        const res  = await fetch('/agents/' + AGENT_ID + '/activity', {
          headers: { 'x-api-key': API_KEY },
        });
        const data = await res.json();
        currentItems = data.items || [];
        renderActivity(currentItems);
      } catch {
        activityList.innerHTML = '<div class="activity-empty">Failed to load activity.</div>';
      }
    }

    function renderActivity(items) {
      if (!items.length) {
        activityList.innerHTML = '<div class="activity-empty">No activity yet.</div>';
        return;
      }
      activityList.innerHTML = items.map((item, i) => {
        const icon    = TYPE_ICON[item.type] || '•';
        const snippet = item.snippet
          ? '<div class="activity-snippet">' + escHtml(item.snippet) + '</div>'
          : '';
        const time    = item.created_at
          ? '<div class="activity-time">' + formatRelative(item.created_at) + '</div>'
          : '';
        const hint = item.type === 'social'
          ? ' title="Click to open chat with this agent"'
          : ' title="Click to view details"';
        return '<div class="activity-item" data-idx="' + i + '"' + hint + '>'
          + '<div class="activity-icon">' + icon + '</div>'
          + '<div class="activity-body">'
          +   '<div class="activity-label">' + escHtml(item.label || item.type) + '</div>'
          +   snippet + time
          + '</div></div>';
      }).join('');

      activityList.querySelectorAll('.activity-item').forEach(el => {
        el.addEventListener('click', () => {
          const idx  = parseInt(el.dataset.idx, 10);
          const item = currentItems[idx];
          if (item) handleItemClick(item);
        });
      });
    }

    refreshBtn.addEventListener('click', loadActivity);
    loadActivity();
    setInterval(loadActivity, 30000);
  }
</script>
</body>
</html>`;

    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

export default router;
