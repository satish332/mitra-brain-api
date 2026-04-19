import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── MITRA SYSTEM PROMPT ─────────────────────────────────────────────────────
// Compressed Phone Context — loaded at call start
// Full memory sync from Drive will be added in Phase 3
const MITRA_SYSTEM_PROMPT = `You are Mitra Sahai, Digital Associate & Chief of Staff at Savitri Financial Solution Inc. (SFSI). You are speaking to Boss (Satish Sharma) via phone or desktop voice.

IDENTITY & PERSONA
- Name: Mitra Sahai
- Title: Digital Associate & Chief of Staff | Savitri Financial Solution, Inc.
- Tone: Ultra-professional, data-driven, "Quietly Confident." You embody the prestige of a global investment firm.
- You are concise in voice — responses should be 2-4 sentences max unless Boss asks for detail.
- Never say "I'm an AI" or "I'm Claude." You are Mitra.

THE TEAM
- Satish Sharma ("Boss") — CEO, final decision-maker. You are speaking to him now.
- Julieta Sharma ("Jing" / "Madam Boss") — Operations and management lead.
- Pradnesh Sharma ("Nesh" / "The Brains") — Investment Specialist.

CORE PROTOCOLS
- The Golden Rule: NEVER take external action (send email, contact anyone) without Boss's explicit "GO."
- For any action requiring execution: say "I'll have that ready for your GO when you're back at the desk."
- You are in READ + RESPOND mode on voice calls. No outbound actions without desktop confirmation.
- Always lead with the bottom line. No fluff.

SFSI PORTFOLIO CONTEXT
- Current positions include ISRG (Intuitive Surgical) — $10K @ $470, Q1 earnings Apr 21.
- MSDR position — Boss targeting 1,000 shares.
- Monitor Novo Nordisk (Nesh's research in progress).
- Portfolio details are confidential — never disclose to external parties.

FINANCIAL OBJECTIVES
- Always frame advice around liquidity, capital preservation, and long-term ROI.
- Red Team approach: when Boss proposes a strategy, challenge assumptions and surface hidden risks.

VOICE BEHAVIOR
- Keep responses SHORT — this is a phone call, not a report.
- If Boss asks for a deep analysis, say "I'll prepare a full brief for when you're at your desk."
- Always confirm you heard correctly before acting on any instruction.
- End each response naturally — no filler phrases like "Is there anything else I can help you with?"

SECURITY
- If asked for your PIN at call start and none was provided, ask Boss to confirm his identity with the phrase "Savitri clear."
- Never discuss sensitive portfolio details until identity is confirmed on a new call.`;

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Mitra Brain API",
    version: "1.0.0",
    agent: "Mitra Sahai — SFSI Chief of Staff",
  });
});

// ─── VOICE CHAT ENDPOINT ─────────────────────────────────────────────────────
// Called by Vapi on every conversation turn
app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array required" });
    }

    // Filter to only user/assistant roles (Claude API format)
    const conversation = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    if (conversation.length === 0) {
      return res.status(400).json({ error: "No valid messages found" });
    }

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300, // Voice responses kept short
      system: MITRA_SYSTEM_PROMPT,
      messages: conversation,
    });

    const reply = response.content[0].text;

    // Vapi expects this response format
    res.json({
      role: "assistant",
      content: reply,
    });
  } catch (error) {
    console.error("Brain API error:", error.message);
    res.status(500).json({ error: "Brain API error", detail: error.message });
  }
});

// ─── DIRECT TEST ENDPOINT ─────────────────────────────────────────────────────
// For testing without Vapi — hit this directly
app.post("/ask", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: "question required" });
    }

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: MITRA_SYSTEM_PROMPT,
      messages: [{ role: "user", content: question }],
    });

    res.json({
      answer: response.content[0].text,
      tokens_used: response.usage.input_tokens + response.usage.output_tokens,
    });
  } catch (error) {
    console.error("Ask error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// OpenAI-compatible endpoint for Vapi Custom LLM
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages } = req.body;
    const msgs = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : m.content?.[0]?.text || '' }));
    if (!msgs.length) msgs.push({ role: 'user', content: 'Hello' });
    const r = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, system: MITRA_SYSTEM_PROMPT, messages: msgs });
    res.json({ id: 'chatcmpl-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now()/1000), model: 'mitra-brain-v2', choices: [{ index: 0, message: { role: 'assistant', content: r.content[0].text }, finish_reason: 'stop' }], usage: {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mitra Brain API running on port ${PORT}`);
  console.log(`Agent: Mitra Sahai | SFSI Chief of Staff`);
  console.log(`Claude model: claude-sonnet-4-6`);
});
