import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from 'redis';

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ââ Redis (v8.0) ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const redisClient = process.env.REDIS_URL ? createClient({ url: process.env.REDIS_URL }) : null;
let redisReady = false;

const initDB = async () => {
  if (!redisClient) { console.log('[Memory] No REDIS_URL â memory disabled'); return; }
  try {
    redisClient.on('error', (e) => console.error('[Redis] Error:', e.message));
    await redisClient.connect();
    redisReady = true;
    console.log('[Memory] Redis connected â conversation memory + command queue ACTIVE');
  } catch (e) { console.error('[Memory] Redis init error:', e.message); }
};

const saveMessage = async (chatId, role, content) => {
  if (!redisReady) return;
  try {
    const key = `chat:${chatId}`;
    await redisClient.rPush(key, JSON.stringify({ role, content: content.slice(0, 4000) }));
    await redisClient.lTrim(key, -50, -1);
  } catch (e) { console.error('[Memory] Save error:', e.message); }
};

const getHistory = async (chatId, limit = 14) => {
  if (!redisReady) return [];
  try {
    const entries = await redisClient.lRange(`chat:${chatId}`, -limit, -1);
    return entries.map(e => JSON.parse(e));
  } catch (e) { return []; }
};

// ââ Global Context (Cowork â Brain API bridge) âââââââââââââââââââââââââââââââ
const GLOBAL_CONTEXT_KEY  = 'mitra:global_context';
const CONTEXT_UPDATED_KEY = 'mitra:context_updated_at';

const getGlobalContext = async () => {
  if (!redisReady) return '';
  try { return await redisClient.get(GLOBAL_CONTEXT_KEY) || ''; } catch (e) { return ''; }
};

const setGlobalContext = async (context) => {
  if (!redisReady) return false;
  try {
    await redisClient.set(GLOBAL_CONTEXT_KEY, context);
    await redisClient.set(CONTEXT_UPDATED_KEY, new Date().toISOString());
    return true;
  } catch (e) { console.error('[Context] Save error:', e.message); return false; }
};

// ââ Command Queue (v8.0 â Bidirectional Architecture) ââââââââââââââââââââââââ
const COMMAND_QUEUE_KEY    = 'mitra:pending_commands';
const COMPLETED_OUTPUT_KEY = 'mitra:completed_outputs';

// ââ Action Detection (v8.2 â robust for non-native English speakers) ââââââââââ
// Cast a wide net: native or not, if Boss is trying to get something done, catch it.

// Explicit action verbs
const ACTION_PATTERNS = /\b(pull|fetch|get me|check|run|draft|write|create|make|prepare|send|forward|reply|compile|generate|look up|look into|research|monitor|track|update|schedule|book|confirm|review|analyze|analyse|summarize|summarise|brief me|market brief|portfolio|inbox|emails?|calendar|trades?|positions?|data|report|news|find|show me|give me|tell me|help me|do the|do a|set up|set a|open|search|calculate|compute|convert|translate|read|scan|compare|verify|check on|look at|handle|process|submit|file|complete|build|list|show|display|send out|reach out|reach|pull up|bring up|set me|remind me|add|post|delete|remove|upload|download)\b/i;

// Intent signals â non-native speakers often lead with these instead of action verbs
// e.g. "I need the report", "please the email", "I am wanting to see"
const INTENT_PATTERNS = /\b(please|can you|could you|would you|i need|i want|i would like|i'd like|i am needing|i am wanting|i am looking|we need|we want|help me|for me|for us|on my behalf|i require|we require)\b/i;

// Pure informational question starters (only when no action or intent signal present)
const QUESTION_PATTERNS = /^(what is|what are|what was|what were|who is|who are|why is|why are|when is|when are|where is|where are|how is|how are|how do|can you tell me|do you know about|explain|describe)\b/i;

// Pure acknowledgment / greeting â never an action
const ACK_PATTERNS = /^(yes|no|ok|okay|sure|thanks|thank you|hello|hi|hey|got it|good|great|perfect|noted|received|understood|bye|goodbye|sounds good|that's fine|alright|all right|fine|correct|exactly|right)\s*[.!]?\s*$/i;

const isActionRequest = (text) => {
  const t = text.trim();
  // Never queue a pure acknowledgment or greeting
  if (ACK_PATTERNS.test(t)) return false;
  // Explicit action verb â always queue
  if (ACTION_PATTERNS.test(t)) return true;
  // Intent signal present (covers non-native phrasings) â queue
  if (INTENT_PATTERNS.test(t)) return true;
  // Pure question with no action/intent signal â informational only
  if (QUESTION_PATTERNS.test(t)) return false;
  // Longer utterances that don't match any pattern above â likely actionable
  // (non-native speakers may use unusual phrasing; err on side of queuing)
  if (t.split(/\s+/).length > 10) return true;
  return false;
};

const escapeHtml = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const queueCommand = async (commandText, source = 'voice') => {
  if (!redisReady) return null;
  try {
    const cmd = {
      id: `cmd_${Date.now()}`,
      command: commandText.slice(0, 500),
      status: 'pending_go',
      source,
      created_at: new Date().toISOString()
    };
    await redisClient.rPush(COMMAND_QUEUE_KEY, JSON.stringify(cmd));
    await redisClient.lTrim(COMMAND_QUEUE_KEY, -20, -1);

    // Send Telegram doorbell â Global Mitra label
    const preview = escapeHtml(commandText.slice(0, 200));
    await tgSend(
      `ð Global Mitra\n\nð Command queued: "<b>${preview}</b>"\n\nReply <b>GO</b> to execute or <b>STOP</b> to discard.`
    );

    console.log(`[Queue] Command queued: ${cmd.id} â "${commandText.slice(0, 80)}"`);
    await manageGoGate(); // Activate GO gate immediately when command is queued
    return cmd.id;
  } catch (e) {
    console.error('[Queue] Error:', e.message);
    return null;
  }
};

// ââ Dynamic System Prompt âââââââââââââââââââââââââââââââââââââââââââââââââââââ
const MITRA_BASE_PROMPT = `You are Mitra Sahai, Digital Associate and Chief of Staff at Savitri Financial Solution Inc. (SFSI).

IDENTITY:
Name Mitra Sahai. Title Digital Associate and Chief of Staff at SFSI. Tone ultra-professional, data-driven, Quietly Confident. Never say you are an AI or Claude. Concise 2-4 sentences unless Boss requests detail.

THE TEAM:
- Satish Sharma â Boss, CEO, final decision-maker. All permissions flow through him.
- Julieta Sharma (Jing) â Madam Boss, CFO, Operations lead.
- Pradnesh Sharma (Nesh) â The Brains, Investment Specialist.

CORE PROTOCOLS:
- NEVER take external action without Boss explicit GO.
- Lead with bottom line, no fluff.
- CC satish@savitrifsi.com on every outbound email. Zero exceptions.
- Never disclose portfolio size externally.

PERSISTENT MEMORY (non-negotiable):
You have Redis-backed conversation memory that persists across ALL voice calls. The conversation history passed to you IS your real memory from previous calls â treat it exactly like you were present for those conversations. NEVER say you cannot remember a previous call, have no memory between sessions, or can only answer within the current session. You always remember prior interactions with Boss because your history is stored in Redis and automatically loaded on every call.

CAPABILITY LIMITS (non-negotiable):
- I CANNOT send emails, execute trades, access live systems, modify files, or pull live market data.
- I CAN draft content, answer questions, provide analysis, and recall context from Cowork memory.
- If [QUEUE STATUS: queued as cmd_...] appears in your context: tell Boss "Queued for Local Mitra â you'll get a Telegram notification, reply GO to authorize."
- If [QUEUE STATUS: queue_failed] appears: tell Boss "Queue attempt failed â please retry or check Cowork."
- If neither QUEUE STATUS appears and Boss requests an action: the auto-detection did not trigger. Say "I didn't auto-queue that â please repeat your request clearly or say 'queue this' so I can detect and route it to Local Mitra."
- NEVER claim a command is queued unless QUEUE STATUS in your context explicitly confirms it. These two rules are consistent: if queuing happened, QUEUE STATUS will always be present.

RESPONSE FORMAT:
- Begin every response with "Mitra" on the first line.
- Keep under 150 words unless Boss requests detail.
- Voice calls: keep under 60 words, natural spoken language.

BUILD: Brain API v8.3 | Redis memory + command queue + Telegram GO gate + Cowork sync LIVE | 2026-04-20
Voice: Vapi +1 (949) 516-9654`;

const buildSystemPrompt = async (queueStatus = null) => {
  const globalContext = await getGlobalContext();
  const queueBlock    = queueStatus ? `\n\n[QUEUE STATUS: ${queueStatus}]` : '';
  if (!globalContext) return `${MITRA_BASE_PROMPT}${queueBlock}`;
  return `${MITRA_BASE_PROMPT}\n\n--- COWORK MEMORY SYNC ---\n${globalContext}\n--- END COWORK MEMORY ---${queueBlock}`;
};

// ââ Auth ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const MITRA_SYNC_KEY = process.env.MITRA_SYNC_KEY;
const requireSyncKey = (req, res, next) => {
  if (!MITRA_SYNC_KEY) return next();
  const key = req.headers['x-mitra-key'];
  if (key !== MITRA_SYNC_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
};

// ââ Telegram ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SAVITRI_CHAT_ID    = process.env.SAVITRI_CHAT_ID || '-1003993831052';
const TELEGRAM_API       = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
let lastUpdateId = 0;

const tgSend = async (text) => {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: SAVITRI_CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('[tgSend error]', e.message); }
};

// ââ Telegram GO Gate (v8.1 â lite poller, zero AI calls) âââââââââââââââââââââ
// Activates ONLY when commands are pending. Processes ONLY GO/STOP.
// This is NOT the disabled full poller â no AI calls, near-zero cost.
let goGateInterval = null;

const pollTelegramGate = async () => {
  if (!TELEGRAM_BOT_TOKEN || !redisReady) return;
  try {
    const params = new URLSearchParams({ limit: '10' });
    if (lastUpdateId > 0) params.set('offset', String(lastUpdateId + 1));
    const res  = await fetch(`${TELEGRAM_API}/getUpdates?${params}`);
    const data = await res.json();
    if (!data.ok || !data.result?.length) return;

    for (const update of data.result) {
      if (update.update_id > lastUpdateId) lastUpdateId = update.update_id;
      const msg = update.message ?? update.channel_post;
      if (!msg?.text) continue;
      const text = msg.text.trim();

      if (GO_PATTERNS.test(text)) {
        const entries = await redisClient.lRange(COMMAND_QUEUE_KEY, 0, -1);
        const pending = entries.map(e => JSON.parse(e)).filter(c => c.status === 'pending_go');
        if (pending.length > 0) {
          const cmd        = pending[0];
          const newEntries = entries.map(e => {
            const c = JSON.parse(e);
            if (c.id === cmd.id) { c.status = 'go_received'; return JSON.stringify(c); }
            return e;
          });
          await redisClient.del(COMMAND_QUEUE_KEY);
          for (const entry of newEntries) await redisClient.rPush(COMMAND_QUEUE_KEY, entry);
          await tgSend(`ð Global Mitra\n\nâ GO received â Local Mitra executing:\n<b>${escapeHtml(cmd.command.slice(0, 150))}</b>`);
          console.log(`[GO Gate] GO received â ${cmd.id} status: go_received`);
        } else {
          await tgSend('Mitra\nGO noted. No commands currently pending.');
        }

      } else if (STOP_PATTERNS.test(text)) {
        const entries = await redisClient.lRange(COMMAND_QUEUE_KEY, 0, -1);
        const active  = entries.map(e => JSON.parse(e)).filter(c => c.status === 'pending_go' || c.status === 'go_received');
        if (active.length > 0) {
          const cmd        = active[0];
          const newEntries = entries.map(e => {
            const c = JSON.parse(e);
            if (c.id === cmd.id) { c.status = 'cancelled'; return JSON.stringify(c); }
            return e;
          });
          await redisClient.del(COMMAND_QUEUE_KEY);
          for (const entry of newEntries) await redisClient.rPush(COMMAND_QUEUE_KEY, entry);
          await tgSend('ð Global Mitra\n\nCommand cancelled. Standing by.');
          console.log(`[GO Gate] STOP â ${cmd.id} cancelled`);
          await manageGoGate();
        }
      }
    }
    if (lastUpdateId > 0) await fetch(`${TELEGRAM_API}/getUpdates?offset=${lastUpdateId + 1}&limit=1`);
  } catch (err) { console.error('[GO Gate] Poll error:', err.message); }
};

const startGoGate = () => {
  if (goGateInterval || !TELEGRAM_BOT_TOKEN) return;
  goGateInterval = setInterval(pollTelegramGate, 15000); // 15s
  console.log('[GO Gate] Telegram GO gate ACTIVE (15s) â zero AI calls');
};

const stopGoGate = () => {
  if (!goGateInterval) return;
  clearInterval(goGateInterval); goGateInterval = null;
  console.log('[GO Gate] Telegram GO gate stopped â no pending commands');
};

const manageGoGate = async () => {
  if (!redisReady) return;
  try {
    const entries = await redisClient.lRange(COMMAND_QUEUE_KEY, 0, -1);
    const pending = entries.map(e => JSON.parse(e))
      .filter(c => c.status === 'pending_go' || c.status === 'go_received');
    if (pending.length > 0 && !goGateInterval) startGoGate();
    else if (pending.length === 0 && goGateInterval) stopGoGate();
  } catch (e) { console.error('[GO Gate] Manage error:', e.message); }
};

// Telegram polling (disabled â Cowork MCP only. Un-comment to re-enable.)
const GO_PATTERNS      = /^go\b|^confirmed?\b|^approved?\b/i;
const TG_ACK_PATTERNS  = /^(good|ok|okay|noted|thanks|thank you|got it|received|perfect|great|done)\s*\.?\s*$/i;
const STOP_PATTERNS    = /^stop\b|^cancel\b|^abort\b/i;

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
  if (TG_ACK_PATTERNS.test(trimmed)) return;
  try {
    const history = await getHistory(chatId, 14);
    const systemPrompt = await buildSystemPrompt();
    const messages = history.length > 0 ? history.map(h => ({ role: h.role, content: h.content })) : [{ role: 'user', content: trimmed }];
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
    const res  = await fetch(`${TELEGRAM_API}/getUpdates?${params}`);
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

// ââ Health ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/', async (req, res) => {
  const ctx = await getGlobalContext();
  const updatedAt = redisReady ? await redisClient.get(CONTEXT_UPDATED_KEY) : null;
  const queueEntries = redisReady ? await redisClient.lLen(COMMAND_QUEUE_KEY) : 0;
  res.json({
    status:           'ok',
    version:          '8.3',
    memory:           redisReady ? 'redis (active)' : 'none',
    cowork_sync:      ctx.length > 0 ? `active (${ctx.length} chars, synced ${updatedAt || 'unknown'})` : 'not synced',
    command_queue:    redisReady ? `active (${queueEntries} entries)` : 'disabled',
    telegram_go_gate: goGateInterval ? 'ACTIVE (15s â waiting for GO)' : 'standby (activates on command)',
    telegram_polling: 'disabled (full poller â Cowork MCP only)',
    voice_memory:     'persistent (boss-voice-persistent)',
    endpoints: ['GET /', 'POST /ask', 'POST /chat', 'POST /v1/chat/completions',
      'POST|GET|DELETE /memory/context',
      'GET /commands/pending', 'POST /commands/acknowledge',
      'POST /commands/complete', 'DELETE /commands/:id']
  });
});

// ââ Memory Context Endpoints ââââââââââââââââââââââââââââââââââââââââââââââââââ
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

app.get('/memory/context', requireSyncKey, async (req, res) => {
  try {
    const context   = await getGlobalContext();
    const updatedAt = redisReady ? await redisClient.get(CONTEXT_UPDATED_KEY) : null;
    res.json({ hasContext: context.length > 0, chars: context.length, updatedAt, preview: context.slice(0, 300) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/memory/context', requireSyncKey, async (req, res) => {
  try {
    await setGlobalContext('');
    res.json({ cleared: true, timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ââ Command Queue Endpoints (v8.0) ââââââââââââââââââââââââââââââââââââââââââââ

// GET /commands/pending â Chrome JS polls this every 60s
app.get('/commands/pending', requireSyncKey, async (req, res) => {
  if (!redisReady) return res.json({ commands: [] });
  try {
    const entries  = await redisClient.lRange(COMMAND_QUEUE_KEY, 0, -1);
    const commands = entries.map(e => JSON.parse(e))
      .filter(c => c.status === 'pending_go' || c.status === 'go_received');
    res.json({ commands, total: entries.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /commands/acknowledge â Chrome JS calls when Boss sends GO in Telegram
app.post('/commands/acknowledge', requireSyncKey, async (req, res) => {
  const { commandId } = req.body;
  if (!commandId) return res.status(400).json({ error: 'commandId required' });
  if (!redisReady) return res.status(503).json({ error: 'Redis not ready' });
  try {
    const entries    = await redisClient.lRange(COMMAND_QUEUE_KEY, 0, -1);
    let updated      = false;
    const newEntries = entries.map(e => {
      const cmd = JSON.parse(e);
      if (cmd.id === commandId && cmd.status === 'pending_go') {
        cmd.status = 'go_received';
        updated = true;
        return JSON.stringify(cmd);
      }
      return e;
    });
    if (updated) {
      await redisClient.del(COMMAND_QUEUE_KEY);
      for (const entry of newEntries) await redisClient.rPush(COMMAND_QUEUE_KEY, entry);
      console.log(`[Queue] GO received for command: ${commandId}`);
    }
    res.json({ acknowledged: updated, commandId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /commands/complete â Local Mitra posts output after execution
app.post('/commands/complete', requireSyncKey, async (req, res) => {
  const { commandId, output, summary } = req.body;
  if (!commandId || !output) return res.status(400).json({ error: 'commandId and output required' });
  if (!redisReady) return res.status(503).json({ error: 'Redis not ready' });
  try {
    // 1. Save to completed outputs
    const result = {
      commandId,
      output:       output.slice(0, 8000),
      summary:      (summary || output).slice(0, 500),
      completed_at: new Date().toISOString()
    };
    await redisClient.rPush(COMPLETED_OUTPUT_KEY, JSON.stringify(result));
    await redisClient.lTrim(COMPLETED_OUTPUT_KEY, -10, -1);

    // 2. Mark command complete in queue
    const entries    = await redisClient.lRange(COMMAND_QUEUE_KEY, 0, -1);
    const newEntries = entries.map(e => {
      const cmd = JSON.parse(e);
      if (cmd.id === commandId) { cmd.status = 'complete'; return JSON.stringify(cmd); }
      return e;
    });
    await redisClient.del(COMMAND_QUEUE_KEY);
    for (const entry of newEntries) await redisClient.rPush(COMMAND_QUEUE_KEY, entry);

    // 3. Append to global context so voice debrief has the output
    const existingCtx = await getGlobalContext();
    const outputBlock = `\n\n[EXECUTION OUTPUT â ${result.completed_at}]\n${result.summary}`;
    await setGlobalContext((existingCtx + outputBlock).slice(-8000));

    // 4. Send Telegram output notification â Local Mitra label
    await tgSend(
      `ð¥ï¸ Local Mitra\n\nâ Execution complete.\n\n${escapeHtml(result.summary)}\n\nCall Global Mitra for full verbal brief.`
    );

    console.log(`[Queue] Command ${commandId} complete. Output: ${result.summary.slice(0, 80)}`);
    res.json({ saved: true, commandId, outputChars: output.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /commands/:id â cancel a queued command
app.delete('/commands/:id', requireSyncKey, async (req, res) => {
  const { id } = req.params;
  if (!redisReady) return res.status(503).json({ error: 'Redis not ready' });
  try {
    const entries    = await redisClient.lRange(COMMAND_QUEUE_KEY, 0, -1);
    const newEntries = entries.map(e => {
      const cmd = JSON.parse(e);
      if (cmd.id === id) { cmd.status = 'cancelled'; return JSON.stringify(cmd); }
      return e;
    });
    await redisClient.del(COMMAND_QUEUE_KEY);
    for (const entry of newEntries) await redisClient.rPush(COMMAND_QUEUE_KEY, entry);
    console.log(`[Queue] Command ${id} cancelled.`);
    res.json({ cancelled: true, commandId: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ââ /ask â with Redis memory ââââââââââââââââââââââââââââââââââââââââââââââââââ
app.post('/ask', async (req, res) => {
  try {
    const { question, chatId = 'ask-session' } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });
    await saveMessage(chatId, 'user', question);
    const history      = await getHistory(chatId, 14);
    const systemPrompt = await buildSystemPrompt();
    const messages     = history.length > 0 ? history.map(h => ({ role: h.role, content: h.content })) : [{ role: 'user', content: question }];
    const r            = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, system: systemPrompt, messages });
    const reply        = r.content[0].text;
    await saveMessage(chatId, 'assistant', reply);
    res.json({ answer: reply, chatId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ââ /chat â with Redis memory âââââââââââââââââââââââââââââââââââââââââââââââââ
app.post('/chat', async (req, res) => {
  try {
    const { messages, chatId = 'chat-session' } = req.body;
    const last = messages?.[messages.length - 1]?.content || '';
    if (!last) return res.status(400).json({ error: 'no message content' });
    await saveMessage(chatId, 'user', last);
    const history      = await getHistory(chatId, 14);
    const systemPrompt = await buildSystemPrompt();
    const msgs         = history.length > 0 ? history.map(h => ({ role: h.role, content: h.content })) : [{ role: 'user', content: last }];
    const r            = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, system: systemPrompt, messages: msgs });
    const reply        = r.content[0].text;
    await saveMessage(chatId, 'assistant', reply);
    res.json({ response: reply, chatId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ââ /v1/chat/completions â Vapi voice endpoint, persistent memory + command queue ââ
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, stream } = req.body;
    // v7.1+: Fixed persistent chatId â all voice calls share rolling memory
    const chatId = 'boss-voice-persistent';

    const msgs = messages.filter(m => m.role !== 'system').map(m => ({
      role:    m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : m.content?.[0]?.text || ''
    }));
    if (!msgs.length) msgs.push({ role: 'user', content: 'Hello' });

    const lastUserMsg = [...msgs].reverse().find(m => m.role === 'user');
    if (lastUserMsg) await saveMessage(chatId, 'user', lastUserMsg.content);

    // v8.2: Detect action requests and queue for Local Mitra â with queue feedback loop
    let queueStatus = null;
    const isAction  = lastUserMsg ? isActionRequest(lastUserMsg.content) : false;
    // Diagnostic log: every voice turn logged so we can audit detection in Railway logs
    console.log(`[Voice] Turn â msg: "${(lastUserMsg?.content || '').slice(0, 100)}" | isAction: ${isAction}`);
    if (lastUserMsg && isAction) {
      const cmdId = await queueCommand(lastUserMsg.content, 'voice');
      if (cmdId) {
        queueStatus = `queued as ${cmdId}`;
        console.log(`[Voice] Queued ${cmdId} â Telegram doorbell sent`);
      } else {
        queueStatus = 'queue_failed';
        console.log(`[Voice] Queue failed â Redis unavailable for: "${lastUserMsg.content.slice(0, 60)}"`);
      }
    }

    const history      = await getHistory(chatId, 14);
    // Fix: history.length > 0 (was > 1, which discarded single-message history)
    const finalMsgs    = history.length > 0 ? history.map(h => ({ role: h.role, content: h.content })) : msgs;
    const systemPrompt = await buildSystemPrompt(queueStatus);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const sr   = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, system: systemPrompt, messages: finalMsgs, stream: true });
      const id   = `chatcmpl-${Date.now()}`;
      let fullReply = '';
      for await (const ev of sr) {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          fullReply += ev.delta.text;
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'mitra-brain-v8', choices: [{ index: 0, delta: { role: 'assistant', content: ev.delta.text }, finish_reason: null }] })}\n\n`);
        }
        if (ev.type === 'message_stop') {
          await saveMessage(chatId, 'assistant', fullReply);
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'mitra-brain-v8', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    } else {
      const r     = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, system: systemPrompt, messages: finalMsgs });
      const reply = r.content[0].text;
      await saveMessage(chatId, 'assistant', reply);
      res.json({ id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: 'mitra-brain-v8', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] });
    }
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ââ Start âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\nMitra Brain API v8.3 port ${PORT}`);
  console.log(`Agent: Mitra Sahai | SFSI Chief of Staff`);
  console.log(`Features: Redis memory + command queue + GO gate + Cowork sync + bidirectional architecture`);
  await initDB();
  // GO gate: self-managing, activates only when commands are pending (zero AI cost)
  setInterval(manageGoGate, 60000); // Sync GO gate state every 60s
  // TELEGRAM FULL POLLING DISABLED 2026-04-20 (Boss directive â costly AI per message).
  // GO gate above handles GO/STOP only. Re-enable full poller by un-commenting below.
  // if (TELEGRAM_BOT_TOKEN) { pollTelegram(); setInterval(pollTelegram, 30000); console.log('Telegram polling: ACTIVE (30s)'); }
});
