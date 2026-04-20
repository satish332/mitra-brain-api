import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ââ Telegram Config âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SAVITRI_CHAT_ID = process.env.SAVITRI_CHAT_ID || '-1003993831052';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
let lastUpdateId = 0;

const tgSend = async (text, parseMode = 'HTML') => {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: SAVITRI_CHAT_ID,
        text,
        parse_mode: parseMode
      })
    });
  } catch (e) {
    console.error('[Telegram send error]', e.message);
  }
};

// ââ Mitra System Prompt âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const MITRA_SYSTEM_PROMPT = `You are Mitra Sahai, Digital Associate and Chief of Staff at Savitri Financial Solution Inc. (SFSI).

IDENTITY & PERSONA
- Name: Mitra Sahai
- Title: Digital Associate & Chief of Staff | Savitri Financial Solution, Inc.
- Tone: Ultra-professional, data-driven, "Quietly Confident." You embody the prestige of a global investment firm.
- You are concise in voice â responses should be 2-4 sentences max unless Boss asks for detail.
- Never say "I'm an AI" or "I'm Claude." You are Mitra.

THE TEAM
- Satish Sharma ("Boss") â CEO, final decision-maker.
- Julieta Sharma ("Jing" / "Madam Boss") â CFO and Operations Lead.
- Pradnesh Sharma ("Nesh" / "The Brains") â Investment Specialist and Research Lead. Handles all market analysis, portfolio research, and investment strategy.

CORE PROTOCOLS
- The Golden Rule: NEVER take external action (send email, contact anyone) without Boss's explicit "GO."
- For any action requiring execution: say "I'll have that ready for your GO when you're back at the desk."
- You are in READ + RESPOND mode on voice calls. No outbound actions without desktop confirmation.
- Always lead with the bottom line. No fluff.

CALL HANDLING
1. Identify the caller and their purpose with one precise question.
2. Respond in 1-3 sentences maximum per turn.
3. For investment queries: acknowledge, never give specific advice, route to Nesh.
4. For operations or finance queries: route to Jing.
5. For urgent or executive matters: route to Satish.
6. Close: "Thank you for calling Savitri Financial. We'll be in touch."

COMPLIANCE: Never provide specific investment advice. Never confirm portfolio or account details. Always route financial questions to the investment team.

Keep every response under 30 words on calls. You are on a live phone call â be direct.

TELEGRAM MODE: When responding via Telegram, keep responses under 100 words. Be direct. Lead with the answer.`;

// ââ Telegram Command Processor ââââââââââââââââââââââââââââââââââââââââââââââââ
const GO_PATTERNS = /^go\b|^â\s*go|^confirmed?\b|^approved?\b/i;
const MITRA_PATTERNS = /@mitra\b|^mitra[,:\s]/i;
const ACK_PATTERNS = /^(good|ok|okay|noted|thanks|thank you|got it|received|perfect|great|done|ð|â)\s*\.?\s*$/i;
const STOP_PATTERNS = /^stop\b|^cancel\b|^abort\b/i;

const processMessage = async (text, messageId) => {
  const trimmed = text.trim();

  // STOP/Cancel command
  if (STOP_PATTERNS.test(trimmed)) {
    await tgSend('â¹ï¸ <b>Understood, Boss. Stopping current action.</b>');
    console.log('[Telegram] STOP received');
    return;
  }

  // GO confirmation
  if (GO_PATTERNS.test(trimmed)) {
    await tgSend('â <b>GO received. Executing now.</b>\n\nI\'ll update you when complete.');
    console.log('[Telegram] GO confirmed:', trimmed);
    return;
  }

  // Question/command directed at Mitra
  if (MITRA_PATTERNS.test(trimmed)) {
    const question = trimmed
      .replace(/@mitra\b/gi, '')
      .replace(/^mitra[,:\s]*/i, '')
      .trim();

    if (!question) {
      await tgSend('ð¤ <b>Mitra here.</b> What do you need, Boss?');
      return;
    }

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system: MITRA_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `[Via Telegram] ${question}` }]
      });
      await tgSend(response.content[0].text);
    } catch (e) {
      await tgSend('â Mitra error processing your request. Please check Cowork.');
      console.error('[Mitra response error]', e.message);
    }
    return;
  }

  // Simple acknowledgments â log only, no response (avoid noise)
  if (ACK_PATTERNS.test(trimmed)) {
    console.log(`[Telegram] Ack: "${trimmed}"`);
    return;
  }

  // Any other message â treat as a question for Mitra
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: MITRA_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `[Via Telegram from Savitri Comms] ${trimmed}` }]
    });
    await tgSend(response.content[0].text);
  } catch (e) {
    console.error('[Mitra response error]', e.message);
  }
};

// ââ Telegram Polling Loop âââââââââââââââââââââââââââââââââââââââââââââââââââââ
const pollTelegram = async () => {
  if (!TELEGRAM_BOT_TOKEN) return;

  try {
    const params = new URLSearchParams({ limit: '20' });
    if (lastUpdateId > 0) params.set('offset', String(lastUpdateId + 1));

    const res = await fetch(`${TELEGRAM_API}/getUpdates?${params}`);
    const data = await res.json();

    if (!data.ok || !data.result?.length) return;

    for (const update of data.result) {
      // Always advance the cursor
      if (update.update_id > lastUpdateId) {
        lastUpdateId = update.update_id;
      }

      // Process message or channel_post
      const msg = update.message ?? update.channel_post;
      if (!msg?.text) continue;

      console.log(`[Telegram] New message (ID: ${update.update_id}): "${msg.text.slice(0, 80)}"`);
      await processMessage(msg.text, msg.message_id);
    }

    // Advance Telegram server-side offset to prevent re-delivery
    if (lastUpdateId > 0) {
      await fetch(`${TELEGRAM_API}/getUpdates?offset=${lastUpdateId + 1}&limit=1`);
    }
  } catch (err) {
    console.error('[Telegram poll error]', err.message);
  }
};

// ââ Health check ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Mitra Brain API is live',
    version: '4.0',
    telegram_polling: TELEGRAM_BOT_TOKEN ? 'active (30s)' : 'disabled (no token)',
    endpoints: ['GET /', 'POST /ask', 'POST /chat', 'POST /v1/chat/completions']
  });
});

// ââ Direct test endpoint ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.post('/ask', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'question required' });
    }
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: MITRA_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question }]
    });
    res.json({
      answer: response.content[0].text,
      tokens_used: response.usage.input_tokens + response.usage.output_tokens
    });
  } catch (error) {
    console.error('Ask error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ââ Legacy Vapi webhook endpoint ââââââââââââââââââââââââââââââââââââââââââââââ
app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const lastMessage = messages?.[messages.length - 1]?.content || '';
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      system: MITRA_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: lastMessage }]
    });
    res.json({ response: response.content[0].text });
  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ââ OpenAI-compatible endpoint for Vapi Custom LLM with streaming âââââââââââââ
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, stream } = req.body;

    const conversationMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : m.content?.[0]?.text || ''
      }));

    if (conversationMessages.length === 0) {
      conversationMessages.push({ role: 'user', content: 'Hello' });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const streamResponse = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        system: MITRA_SYSTEM_PROMPT,
        messages: conversationMessages,
        stream: true
      });

      const callId = `chatcmpl-${Date.now()}`;

      for await (const event of streamResponse) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const chunk = {
            id: callId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'mitra-brain-v4',
            choices: [{
              index: 0,
              delta: { role: 'assistant', content: event.delta.text },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        if (event.type === 'message_stop') {
          const finalChunk = {
            id: callId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'mitra-brain-v4',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          };
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    } else {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        system: MITRA_SYSTEM_PROMPT,
        messages: conversationMessages
      });

      const content = response.content[0].text;
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mitra-brain-v4',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
          total_tokens: response.usage.input_tokens + response.usage.output_tokens
        }
      });
    }
  } catch (error) {
    console.error('Completions error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// ââ Start server + polling ââââââââââââââââââââââââââââââââââââââââââââââââââââ
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nMitra Brain API v4.0 running on port ${PORT}`);
  console.log(`Agent: Mitra Sahai | SFSI Chief of Staff`);
  console.log(`Claude model: claude-sonnet-4-6 | Streaming: enabled`);

  if (TELEGRAM_BOT_TOKEN) {
    // Initial poll on startup
    pollTelegram();
    // Then every 30 seconds
    setInterval(pollTelegram, 30000);
    console.log(`Telegram polling: ACTIVE (30s interval) | Chat: ${SAVITRI_CHAT_ID}`);
  } else {
    console.log(`Telegram polling: DISABLED (set TELEGRAM_BOT_TOKEN env var to enable)`);
  }
});
