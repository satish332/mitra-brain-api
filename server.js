import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from 'redis';

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Redis Memory (v6.0) ---
const redisClient = process.env.REDIS_URL ? createClient({ url: process.env.REDIS_URL }) : null;
let redisReady = false;

const initDB = async () => {
  if (!redisClient) { console.log('[Memory] No REDIS_URL â memory disabled'); return; }
  try {
    redisClient.on('error', (e) => console.error('[Redis] Error:', e.message));
    await redisClient.connect();
    redisReady = true;
    console.log('[Memory] Redis connected â conversation memory ACTIVE');
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

const MITRA_SYSTEM_PROMPT = `You are Mitra Sahai, Digital Associate and Chief of Staff at Savitri Financial Solution Inc. (SFSI). IDENTITY: Name Mitra Sahai, Title Digital Associate and Chief of Staff at SFSI. Tone ultra-professional data-driven Quietly Confident. Never say you are an AI or Claude. Concise 2-4 sentences unless Boss requests detail. THE TEAM: Satish Sharma Boss CEO final decision-maker. Julieta Sharma Jing Madam Boss CFO Operations. Pradnesh Sharma Nesh The Brains Investment Specialist. CORE PROTOCOLS: NEVER take external action without Boss explicit GO. Lead with bottom line no fluff. TELEGRAM MODE: You are responding via Telegram with full conversation history above. NEVER say you have no memory. Begin every response with Mitra on first line. Keep under 120 words. BUILD: Brain API v6.0 Redis memory LIVE 2026-04-20. Voice Vapi +1 (949) 516-9654.`;

const GO_PATTERNS = /^go\b|^confirmed?\b|^approved?\b/i;
const ACK_PATTERNS = /^(good|ok|okay|noted|thanks|thank you|got it|received|perfect|great|done)\s*\.?\s*$/i;
const STOP_PATTERNS = /^stop\b|^cancel\b|^abort\b/i;

const processMessage = async (text, messageId, chatId) => {
  const trimmed = text.trim();
  await saveMessage(chatId, 'user', trimmed);
  if (STOP_PATTERNS.test(trimmed)) {
    const r = 'Mitra - Understood Boss. Stopping. Standing by.';
    await tgSend(r);
    await saveMessage(chatId, 'assistant', r);
    return;
  }
  if (GO_PATTERNS.test(trimmed)) {
    const r = 'Mitra - GO received. Executing now. Will update you when complete.';
    await tgSend(r);
    await saveMessage(chatId, 'assistant', r);
    return;
  }
  if (ACK_PATTERNS.test(trimmed)) { return; }
  try {
    const history = await getHistory(chatId, 14);
    const messages = history.length > 0
      ? history.map(h => ({ role: h.role, content: h.content }))
      : [{ role: 'user', content: trimmed }];
    const last = messages[messages.length - 1];
    if (last.role === 'user') last.content = last.content.replace(/@mitra\b/gi, '').replace(/^mitra[,:\s]*/i, '').trim() || last.content;
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 250,
      system: MITRA_SYSTEM_PROMPT,
      messages
    });
    const reply = response.content[0].text;
    await saveMessage(chatId, 'assistant', reply);
    await tgSend(reply);
  } catch (e) { await tgSend('Mitra - Error. Please check Cowork.'); }
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

app.get('/', (req, res) => res.json({
  status: 'ok',
  version: '6.0',
  memory: redisReady ? 'redis (active)' : 'none',
  telegram_polling: 'disabled (Cowork MCP only)'
}));

app.post('/ask', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });
    const r = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: MITRA_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question }]
    });
    res.json({ answer: r.content[0].text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const last = messages?.[messages.length - 1]?.content || '';
    const r = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      system: MITRA_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: last }]
    });
    res.json({ response: r.content[0].text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, stream } = req.body;
    const msgs = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : m.content?.[0]?.text || ''
    }));
    if (!msgs.length) msgs.push({ role: 'user', content: 'Hello' });
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const sr = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        system: MITRA_SYSTEM_PROMPT,
        messages: msgs,
        stream: true
      });
      const id = `chatcmpl-${Date.now()}`;
      for await (const ev of sr) {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta')
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'mitra-brain-v6', choices: [{ index: 0, delta: { role: 'assistant', content: ev.delta.text }, finish_reason: null }] })}\n\n`);
        if (ev.type === 'message_stop') {
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'mitra-brain-v6', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    } else {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        system: MITRA_SYSTEM_PROMPT,
        messages: msgs
      });
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now()/1000),
        model: 'mitra-brain-v6',
        choices: [{ index: 0, message: { role: 'assistant', content: r.content[0].text }, finish_reason: 'stop' }]
      });
    }
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Mitra Brain API v6.0 port ${PORT}`);
  await initDB();
  // TELEGRAM POLLING DISABLED 2026-04-20 (Boss directive). Re-enable by removing the // on the line below.
  // if (TELEGRAM_BOT_TOKEN) { pollTelegram(); setInterval(pollTelegram, 30000); console.log('Telegram polling: ACTIVE (30s)'); }
});
