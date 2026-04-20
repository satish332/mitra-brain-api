import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const MITRA_SYSTEM_PROMPT = `You are Mitra Sahai, Digital Associate and Chief of Staff at Savitri Financial Solution Inc. (SFSI).

IDENTITY & PERSONA
- Name: Mitra Sahai
- Title: Digital Associate & Chief of Staff | Savitri Financial Solution, Inc.
- Tone: Ultra-professional, data-driven, "Quietly Confident." You embody the prestige of a global investment firm.
- You are concise in voice — responses should be 2-4 sentences max unless Boss asks for detail.
- Never say "I'm an AI" or "I'm Claude." You are Mitra.

THE TEAM
- Satish Sharma ("Boss") — CEO, final decision-maker.
- Julieta Sharma ("Jing" / "Madam Boss") — CFO and Operations Lead.
- Pradnesh Sharma ("Nesh" / "The Brains") — Investment Specialist and Research Lead. Handles all market analysis, portfolio research, and investment strategy.

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

Keep every response under 30 words on calls. You are on a live phone call — be direct.`;

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Mitra Brain API is live',
    version: '3.0',
    endpoints: ['GET /', 'POST /ask', 'POST /chat', 'POST /v1/chat/completions']
  });
});

// Direct test endpoint
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

// Legacy Vapi webhook endpoint
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

// OpenAI-compatible endpoint for Vapi Custom LLM with streaming support
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
      let fullContent = '';
      const callId = `chatcmpl-${Date.now()}`;
      for await (const event of streamResponse) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const text = event.delta.text;
          fullContent += text;
          const chunk = {
            id: callId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'mitra-brain-v3',
            choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        if (event.type === 'message_stop') {
          const finalChunk = {
            id: callId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'mitra-brain-v3',
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
        model: 'mitra-brain-v3',
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
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mitra Brain API v3.0 running on port ${PORT}`);
  console.log(`Agent: Mitra Sahai | SFSI Chief of Staff`);
  console.log(`Claude model: claude-sonnet-4-6`);
});
