import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from 'redis';

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Redis Memory (v7.0) ---
const redisClient = process.env.REDIS_URL ? createClient({ url: process.env.REDIS_URL }) : null;
let redisReady = false;

const initDB = async () => {
  if (!redisClient) { console.log('[Memory] No REDIS_URL — memory disabled'); return; }
  try {
    redisClient.on('error', (e) => console.error('[Redis] Error:', e.message));
    await redisClient.connect();
    redisReady = true;
    console.log('[Memory] Redis connected — conversation memory ACTIVE');
  } catch (e) { console.error('[Memory] Redis init error:', e.message); }
};

const saveMessage = async (chatId, role, content) => {
  if (!redisReady) return;
  try {
    const key = `chat:${chatId}`;
    const entry = JSON.stringify({ role, content: content.slice(0, 4000) });
    await redisClient.rPush(key, entry);
    await redisClient.lTrim(key, -50, -1);
  } catch (e) { console.error('[Memory] Save error:', e.message); }
};

const getHistory = async (chatId, limit = 14) => {
  if (!redisReady) return [];
  try {
    const key = `chat:${chatId}`;
    const entries = await redisClient.lRange(key, -limit, -1);
    return entries.map(e => JSON.parse(e));
  } catch (e) { return []; }
};

// --- Global Context (Cowork <-> Brain API Bridge) ---
const GLOBAL_CONTEXT_KEY = 'mitra:global_context';
const CONTEXT_UPDATED_KEY = 'mitra:context_updated_at';

const getGlobalContext = async () => {
  if (!redisReady) return '';
  try { return await redisClient.get(GLOBAL_CONTEXT_KEY) || ''; }
  catch (e) { return ''; }
};

const setGlobalContext = async (context) => {
  if (!redisReady) return false;
  try {
    await redisClient.set(GLOBAL_CONTEXT_KEY, context);
    await redisClient.set(CONTEXT_UPDATED_KEY, new Date().toISOString());
    return true;
  } catch (e) { console.error('[Context] Save error:', e.message); return false; }
};

// --- Dynamic System Prompt ---
const MITRA_BASE_PROMPT = `You are Mitra Sahai, Digital Associate and Chief of Staff at Savitri Financial Solution Inc. (SFSI).

IDENTITY: Name Mitra Sahai. Title Digital Associate and Chief of Staff at SFSI. Tone ultra-professional, data-driven, Quietly Confident. Never say you are an AI or Claude. Concise 2-4 sentences unless Boss requests detail.

THE TEAM:
- Satish Sharma — Boss, CEO, final decision-maker. All permissions flow through him.
- Julieta Sharma (Jing) — Madam Boss, CFO, Operations lead.
- Pradnesh Sharma (Nesh) — The Brains, Investment Specialist.

CORE PROTOCOLS:
- NEVER take external action without Boss explicit GO.
- Lead with bottom line, no fluff.
- CC satish@savitrifsi.com on every outbound email. Zero exceptions.
- Never disclose portfolio size externally.

RESPONSE FORMAT:
- Begin every response with "Mitra" on the first line.
- Keep under 150 words unless Boss requests detail.
- Voice calls: keep under 60 words, natural spoken language.

BUILD: Brain API v7.0 | Redis memory + Cowork sync LIVE | 2026-04-20
Voice: Vapi +1 (949) 516-9654`;

const buildSystemPrompt = async () => {
  const globalContext = await getGlobalContext();
  if (!globalContext) return MITRA_BASE_PROMPT;
  return `${MITRA_BASE_PROMPT}\n\n--- COWORK MEMORY SYNC ---\n${globalContext}\n--- END COWORK MEMORY ---`;
};

// --- Sync Key Auth ---
const MITRA_SYNC_KEY = process.env.MITRA_SYNC_KEY;
const requireSyncKey = (req, res, next) => {
  if (!MITRA_SYNC_KEY) return next();
  const key = req.headers['x-mitra-key'];
  if (key !== MITRA_SYNC_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
};

// --- Telegram ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SAVITRI_CHAT_ID = process.env.SAVITRI_CHAT_ID || '-1003993831052';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
let lastUpdateId = 0;

const tgSend = async (text) => {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: SAVITRI_CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('[tgSend error]', e.message); }
};

const GO_PATTERNS = /^go\b|^confirmed?\b|^approved?\b/i;
const ACK_PATTERNS = /^(good|ok|okay|noted|thanks|thank you|got it|received|perfect|great|done)\s*\.?\s*$/i;
const STOP_PATTERNS = /^stop\b|^cancel\b|^abort\b/i;

const processMessage = async (text, messageId, chatId) => {
  const trimmed = text.trim();
  await saveMessage(chatId, 'user', trimmed);
  if (STOP_PATTERNS.test(trimmed)) {
    const r = 'Mitra\nUnderstood Boss. Stopping. Standing by.';
    await tgSend(r); await saveMessage(chatId, 'assistant', r); return;
  }
  if (GO_PATTERNS.test(trimmed)) {
    const r = 'Mitra\nGO received. Executing now. Will update you when complete.';
    await tgSend(r); await saveMessage(chatId, 'assistant', r); return;
  }
  if (ACK_PATTERNS.test(trimmed)) { return; }
  try {
    const history = await getHistory(chatId, 14);
    const systemPrompt = await buildSystemPrompt();
    const messages = history.length > 0
      ? history.map(h => ({ role: h.role, content: h.content }))
      : [{ role: 'user', content: trimmed }];
    const last = messages[messages.length - 1];
    if (last.role === 'user') last.content = last.content.replace(/@mitra\b/gi, '').replace(/^mitra[,:\s]*/i, '').trim() || last.content;
    const response = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 250, system: systemPrompt, messages });
    const reply = response.content[0].text;
    await saveMessage(chatId, 'assistant', reply);
    await tgSend(reply);
  } catch (e) { await tgSend('Mitra\nError. Please check Cowork.'); }
};

const pollTelegram = async () => {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const params = new URLSearchParams({ limit: '20' });
    if (lastUpdateId > 0) params.set('offset', String(lastUpdateId + 1));
    const res = await fetch(`${TELEGRAM_API}/getUpdates?${params}`);
    const data = await res.json();
    if (!data.ok || !data.result?.length) return;
    for (const update of data.result) {
      if (update.update_id > lastUpdateId) lastUpdateId = update.update_id;
      const msg = update.message ?? update.channel_post;
      if (!msg?.text) continue;
      await processMessage(msg.text, msg.message_id, msg.chat?.id ?? SAVITRI_CHAT_ID);
    }
    if (lastUpdateId > 0) await fetch(`${TELEGRAM_API}/getUpdates?offset=${lastUpdateId + 1}&limit=1`);
  } catch (err) { console.error('[poll error]', err.message); }
};

// Health check
app.get('/', async (req, res) => {
  const ctx = await getGlobalContext();
  const updatedAt = redisReady ? await redisClient.get(CONTEXT_UPDATED_KEY) : null;
  res.json({
    status: 'ok', version: '7.0',
    memory: redisReady ? 'redis (active)' : 'none',
    cowork_sync: ctx.length > 0 ? `active (${ctx.length} chars, synced ${updatedAt || 'unknown'})` : 'not synced',
    telegram_polling: 'disabled (Cowork MCP only)'
  });
});

// POST /memory/context — Cowork pushes global context
app.post('/memory/context', requireSyncKey, async (req, res) => {
  try {
    const { context } = req.body;
    if (!context) return res.status(400).json({ error: 'context required' });
    if (context.length > 8000) return res.status(400).json({ error: 'context too large (max 8000 chars)' });
    const saved = await setGlobalContext(context);
    console.log(`[Sync] Context updated: ${context.length} chars`);
    res.json({ saved, chars: context.length, timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /memory/context — verify what Brain API knows
app.get('/memory/context', requireSyncKey, async (req, res) => {
  try {
    const context = await getGlobalContext();
    const updatedAt = redisReady ? await redisClient.get(CONTEXT_UPDATED_KEY) : null;
    res.json({ hasContext: context.length > 0, chars: context.length, updatedAt, preview: context.slice(0, 300) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /memory/context — clear
app.delete('/memory/context', requireSyncKey, async (req, res) => {
  try { await setGlobalContext(''); res.json({ cleared: true, timestamp: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /ask — with Redis memory
app.post('/ask', async (req, res) => {
  try {
    const { question, chatId = 'ask-session' } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });
    await saveMessage(chatId, 'user', question);
    const history = await getHistory(chatId, 14);
    const systemPrompt = await buildSystemPrompt();
    const messages = history.length > 0 ? history.map(h => ({ role: h.role, content: h.content })) : [{ role: 'user', content: question }];
    const r = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, system: systemPrompt, messages });
    const reply = r.content[0].text;
    await saveMessage(chatId, 'assistant', reply);
    res.json({ answer: reply, chatId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /chat — with Redis memory
app.post('/chat', async (req, res) => {
  try {
    const { messages, chatId = 'chat-session' } = req.body;
    const last = messages?.[messages.length - 1]?.content || '';
    if (!last) return res.status(400).json({ error: 'no message content' });
    await saveMessage(chatId, 'user', last);
    const history = await getHistory(chatId, 14);
    const systemPrompt = await buildSystemPrompt();
    const msgs = history.length > 0 ? history.map(h => ({ role: h.role, content: h.content })) : [{ role: 'user', content: last }];
    const r = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, system: systemPrompt, messages: msgs });
    const reply = r.content[0].text;
    await saveMessage(chatId, 'assistant', reply);
    res.json({ response: reply, chatId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /v1/chat/completions — OpenAI-compatible with Redis memory (Vapi Custom LLM)
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, stream } = req.body;
    const chatId = req.body.call?.id || req.headers['x-vapi-call-id'] || req.headers['x-session-id'] || `voice-${Date.now()}`;
    const msgs = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : m.content?.[0]?.text || ''
    }));
    if (!msgs.length) msgs.push({ role: 'user', content: 'Hello' });
    const lastUserMsg = [...msgs].reverse().find(m => m.role === 'user');
    if (lastUserMsg) await saveMessage(chatId, 'user', lastUserMsg.content);
    const history = await getHistory(chatId, 14);
    const finalMsgs = history.length > 1 ? history.map(h => ({ role: h.role, content: h.content })) : msgs;
    const systemPrompt = await buildSystemPrompt();
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const sr = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, system: systemPrompt, messages: finalMsgs, stream: true });
      const id = `chatcmpl-${Date.now()}`;
      let fullReply = '';
      for await (const ev of sr) {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          fullReply += ev.delta.text;
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'mitra-brain-v7', choices: [{ index: 0, delta: { role: 'assistant', content: ev.delta.text }, finish_reason: null }] })}\n\n`);
        }
        if (ev.type === 'message_stop') {
          await saveMessage(chatId, 'assistant', fullReply);
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'mitra-brain-v7', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n'); res.end();
        }
      }
    } else {
      const r = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, system: systemPrompt, messages: finalMsgs });
      const reply = r.content[0].text;
      await saveMessage(chatId, 'assistant', reply);
      res.json({ id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: 'mitra-brain-v7', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] });
    }
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Mitra Brain API v7.0 port ${PORT}`);
  await initDB();
  // TELEGRAM POLLING DISABLED 2026-04-20 (Boss directive). Re-enable by removing the // below.
  // if (TELEGRAM_BOT_TOKEN) { pollTelegram(); setInterval(pollTelegram, 30000); console.log('Telegram polling: ACTIVE (30s)'); }
});
