import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from 'redis';
import pg from 'pg';

const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ââ FMP Market Data Helper ââââââââââââââââââââââââââââââââââââââââââââââââââââ
const FMP_KEY = process.env.FMP_API_KEY || '';
const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

const fmpQuote = async (ticker) => {
  if (!FMP_KEY || !ticker) return null;
  try {
    const r = await fetch(`${FMP_BASE}/quote/${ticker}?apikey=${FMP_KEY}`);
    const d = await r.json();
    return d?.[0] || null;
  } catch { return null; }
};

const fmpNews = async (ticker, limit = 3) => {
  if (!FMP_KEY || !ticker) return [];
  try {
    const r = await fetch(`${FMP_BASE}/stock_news?tickers=${ticker}&limit=${limit}&apikey=${FMP_KEY}`);
    return await r.json() || [];
  } catch { return []; }
};

const fmpProfile = async (ticker) => {
  if (!FMP_KEY || !ticker) return null;
  try {
    const r = await fetch(`${FMP_BASE}/profile/${ticker}?apikey=${FMP_KEY}`);
    const d = await r.json();
    return d?.[0] || null;
  } catch { return null; }
};

// ââ Redis (Conversation Memory) âââââââââââââââââââââââââââââââââââââââââââââââ
const redisClient = process.env.REDIS_URL ? createClient({ url: process.env.REDIS_URL }) : null;
let redisReady = false;

const initRedis = async () => {
  if (!redisClient) { console.log('[Redis] No REDIS_URL â conversation memory disabled'); return; }
  try {
    redisClient.on('error', (e) => console.error('[Redis]', e.message));
    await redisClient.connect();
    redisReady = true;
    console.log('[Redis] Connected â conversation memory ACTIVE');
  } catch (e) { console.error('[Redis] Init error:', e.message); }
};

const saveMessage = async (chatId, role, content) => {
  if (!redisReady) return;
  try {
    await redisClient.rPush(`chat:${chatId}`, JSON.stringify({ role, content: content.slice(0, 4000) }));
    await redisClient.lTrim(`chat:${chatId}`, -50, -1);
  } catch {}
};

const getHistory = async (chatId, limit = 14) => {
  if (!redisReady) return [];
  try {
    const entries = await redisClient.lRange(`chat:${chatId}`, -limit, -1);
    return entries.map(e => JSON.parse(e));
  } catch { return []; }
};

// ââ Global Context (Cowork <> Brain sync) âââââââââââââââââââââââââââââââââââââ
const GLOBAL_CONTEXT_KEY  = 'mitra:global_context';
const CONTEXT_UPDATED_KEY = 'mitra:context_updated_at';

const getGlobalContext = async () => {
  if (!redisReady) return '';
  try { return await redisClient.get(GLOBAL_CONTEXT_KEY) || ''; } catch { return ''; }
};

const setGlobalContext = async (context) => {
  if (!redisReady) return false;
  try {
    await redisClient.set(GLOBAL_CONTEXT_KEY, context);
    await redisClient.set(CONTEXT_UPDATED_KEY, new Date().toISOString());
    return true;
  } catch { return false; }
};

// ââ Postgres (Digital Twin â Institutional Memory) ââââââââââââââââââââââââââââ
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;
let pgReady = false;

const initPostgres = async () => {
  if (!pool) { console.log('[Postgres] No DATABASE_URL â Digital Twin disabled'); return; }
  try {
    await pool.query('SELECT 1');
    pgReady = true;
    console.log('[Postgres] Connected â Digital Twin ACTIVE');
    await createSchema();
    await seedIfEmpty();
    await seedBrokerageData();
  } catch (e) { console.error('[Postgres] Init error:', e.message); }
};

const createSchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id                SERIAL PRIMARY KEY,
      name              TEXT NOT NULL,
      ticker            TEXT,
      sector            TEXT,
      stage             TEXT DEFAULT 'Public',
      status            TEXT DEFAULT 'Active Watch',
      thesis            TEXT,
      conviction_level  INTEGER DEFAULT 3,
      kill_switch       TEXT,
      next_catalyst     TEXT,
      pre_earnings_note TEXT,
      notes             TEXT,
      added_by          TEXT DEFAULT 'Mitra',
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS positions (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER REFERENCES companies(id),
      entry_date    DATE,
      entry_price   NUMERIC(12,4),
      shares        NUMERIC(12,4),
      tranche_plan  JSONB,
      status        TEXT DEFAULT 'Open',
      decision_id   INTEGER,
      notes         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS relationships (
      id                 SERIAL PRIMARY KEY,
      name               TEXT NOT NULL,
      title              TEXT,
      company_id         INTEGER REFERENCES companies(id),
      email              TEXT,
      relationship_type  TEXT,
      last_contact_date  DATE,
      warmth             INTEGER DEFAULT 3,
      notes              TEXT,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id          SERIAL PRIMARY KEY,
      company_id  INTEGER REFERENCES companies(id),
      date        DATE DEFAULT CURRENT_DATE,
      type        TEXT,
      decided_by  TEXT DEFAULT 'Nesh',
      approved_by TEXT DEFAULT 'Boss',
      rationale   TEXT,
      outcome     TEXT DEFAULT 'Pending',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS watchlist_triggers (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER REFERENCES companies(id),
      trigger_type      TEXT,
      trigger_condition TEXT,
      alert_channel     TEXT DEFAULT 'Telegram',
      is_active         BOOLEAN DEFAULT TRUE,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[Postgres] Schema verified â 5 tables ready');
};

// ââ Seed Data â Day 1 Digital Twin Records ââââââââââââââââââââââââââââââââââââ
const seedIfEmpty = async () => {
  const { rows } = await pool.query('SELECT COUNT(*) FROM companies');
  if (parseInt(rows[0].count) > 0) {
    console.log(`[Postgres] Digital Twin has ${rows[0].count} companies â skipping seed`);
    return;
  }
  console.log('[Postgres] Seeding Digital Twin with 5 founding records...');

  const companies = [
    {
      name: 'Intuitive Surgical',
      ticker: 'ISRG',
      sector: 'Medical Devices',
      stage: 'Public',
      status: 'Position Open',
      thesis: 'Structural monopoly on robotic-assisted surgery. The da Vinci system creates a razor-and-blade revenue model â hospitals locked in via training, consumables, and multi-year service contracts. Procedure volume growing 12-15% annually is the primary alpha driver. Global expansion (OUS procedures +20% YoY) provides a second growth engine independent of US hospital capex cycles.',
      conviction_level: 4,
      kill_switch: 'Competition narrows da Vinci gross margin below 60% for two consecutive quarters; FDA approves a competing system at comparable clinical capability at 30%+ lower cost; US procedure growth falls below 8% for two consecutive quarters; management guidance cut materially on FY26 revenue.',
      next_catalyst: 'Q1 2026 Earnings â April 21, 2026. Consensus: EPS $2.08, Revenue $2.61B.',
      pre_earnings_note: 'Pre-earnings consensus (Mitra synthesis, Apr 20 2026): EPS $2.08, Revenue $2.61B. Key watch items: (1) OUS procedure growth rate vs Q4 2025 (+20%), (2) Ion bronchoscopy adoption cadence, (3) FY26 guidance raised/maintained/cut, (4) da Vinci 5 system placement acceleration. Bull case: Beat on revenue + raise guidance = hold and add tranche 2 at $450. Bear case: Miss + guidance cut = re-evaluate thesis, consider trim.',
      notes: 'Position initiated Apr 16 2026 at $470. Tranches 2 and 3 pending at $450 and $430 respectively.',
      added_by: 'Mitra'
    },
    {
      name: 'Novo Nordisk',
      ticker: 'NVO',
      sector: 'Pharmaceuticals',
      stage: 'Public',
      status: 'Active Watch',
      thesis: 'GLP-1 market leader. Ozempic and Wegovy create durable revenue with strong IP protection through 2031. Global obesity epidemic provides multi-decade demand tailwind. Research in progress â Nesh developing full thesis.',
      conviction_level: 3,
      kill_switch: 'Eli Lilly tirzepatide gains >40% market share in obesity indication; GLP-1 cardiovascular benefit claims challenged by FDA; reimbursement coverage materially restricted by major US payers.',
      next_catalyst: 'Q1 2026 Earnings â upcoming. Watch Wegovy supply normalization and US obesity coverage expansion.',
      notes: 'Nesh research in progress. Thesis pending completion. Conviction will be updated on Nesh log.',
      added_by: 'Mitra'
    },
    {
      name: 'OpenAI',
      ticker: null,
      sector: 'Artificial Intelligence',
      stage: 'Pre-IPO',
      status: 'Active Watch',
      thesis: 'Ecosystem leader in the Sovereign AI trend. ChatGPT has 100M+ daily active users creating unrivaled behavioral dataset for model training. Azure partnership provides $13B+ in compute credits and enterprise distribution. GPT-4o multimodal capabilities ahead of open-source alternatives. Primary risk: commoditization of foundation models compresses API margins.',
      conviction_level: 3,
      kill_switch: 'API revenue growth decelerates below 50% YoY; open-source models reach GPT-4 parity at <10% of cost; Microsoft partnership restructured to reduce OpenAI exclusivity; Sam Altman departure.',
      next_catalyst: 'IPO window estimated 2026-2027. Watch: next funding round valuation signal, GPT-5 release timeline, enterprise contract disclosures.',
      notes: 'Pre-IPO target #1. Sovereign AI ecosystem play. Nesh to develop full intelligence brief.',
      added_by: 'Mitra'
    },
    {
      name: 'Anthropic',
      ticker: null,
      sector: 'Artificial Intelligence',
      stage: 'Pre-IPO',
      status: 'Active Watch',
      thesis: 'Safety-first LLM architecture with Constitutional AI creating differentiated enterprise positioning. Claude API gaining enterprise share against GPT-4 on reliability and context window. Amazon investment ($4B) provides compute and distribution. LLM price war primary risk â commoditization compresses margin before IPO.',
      conviction_level: 3,
      kill_switch: 'Claude API pricing falls below sustainable margin; Amazon acquires Anthropic outright (removes IPO optionality); GPT-5 closes safety/reliability gap eliminating differentiation premium.',
      next_catalyst: 'Series F/G funding round or IPO window 2026-2027. Watch: Claude enterprise adoption metrics, API pricing floor stability.',
      notes: 'Pre-IPO target #2. LLM price war intelligence play. Critical for mapping competitive dynamics of Sovereign AI trend.',
      added_by: 'Mitra'
    },
    {
      name: 'Cerebras Systems',
      ticker: null,
      sector: 'AI Hardware',
      stage: 'Pre-IPO',
      status: 'Active Watch',
      thesis: 'Wafer-Scale Engine (WSE) architecture delivers 10x+ inference speed advantage over GPU clusters for large language model workloads. If AI inference becomes the dominant compute use case (vs. training), Cerebras is structurally advantaged. Q2 2026 IPO window makes this SFSI\'s highest-priority near-term pre-IPO opportunity. Key risk: NVIDIA dominance entrenched; customers unwilling to deviate from CUDA ecosystem.',
      conviction_level: 3,
      kill_switch: 'NVIDIA Blackwell architecture closes inference speed gap to <3x; major hyperscaler (AWS/Azure/GCP) declines Cerebras partnership; IPO delayed beyond Q4 2026 indicating demand softness.',
      next_catalyst: 'Q2 2026 IPO window (estimated). S-1 filing will be the primary intelligence trigger â watch for revenue growth rate, customer concentration, and gross margin.',
      notes: 'Pre-IPO target #3. Hardware Alpha play for 2026. IPO timing makes this the most time-sensitive intelligence build.',
      added_by: 'Mitra'
    }
  ];

  for (const c of companies) {
    const { rows } = await pool.query(
      `INSERT INTO companies (name, ticker, sector, stage, status, thesis, conviction_level, kill_switch, next_catalyst, pre_earnings_note, notes, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [c.name, c.ticker, c.sector, c.stage, c.status, c.thesis, c.conviction_level, c.kill_switch, c.next_catalyst, c.pre_earnings_note || null, c.notes, c.added_by]
    );
    const companyId = rows[0].id;

    // Add ISRG position
    if (c.ticker === 'ISRG') {
      await pool.query(
        `INSERT INTO positions (company_id, entry_date, entry_price, shares, tranche_plan, status, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          companyId,
          '2026-04-16',
          470.00,
          21.28,  // ~$10,000 / $470
          JSON.stringify([
            { tranche: 2, price: 450.00, shares_target: 22.22, status: 'Pending' },
            { tranche: 3, price: 430.00, shares_target: 23.26, status: 'Pending' }
          ]),
          'Open',
          'Tranche 1 complete ($10K @ $470). Tranches 2 and 3 pending at $450 and $430.'
        ]
      );

      // Add ISRG watchlist triggers
      await pool.query(
        `INSERT INTO watchlist_triggers (company_id, trigger_type, trigger_condition, alert_channel, is_active)
         VALUES ($1, $2, $3, $4, $5), ($1, $6, $7, $4, $5), ($1, $8, $9, $4, $5)`,
        [
          companyId,
          'Price', 'price <= 450', 'Telegram', true,
          'Price', 'price <= 430', 'Telegram',
          'Earnings', 'Q1 2026 earnings released April 21 2026'
        ]
      );

      // Log the initial buy decision
      await pool.query(
        `INSERT INTO decisions (company_id, date, type, decided_by, approved_by, rationale, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          companyId,
          '2026-04-16',
          'Buy â Tranche 1',
          'Boss',
          'Boss',
          'Initiated position at $470. Robotic surgery monopoly thesis. Tranche-based entry strategy to average down if price pulls back.',
          'Confirmed'
        ]
      );
    }
  }
  console.log('[Postgres] Seeded: ISRG (position + triggers + decision), NVO, OpenAI, Anthropic, Cerebras');
};

// ââ Digital Twin Query Helper âââââââââââââââââââââââââââââââââââââââââââââââââ
const queryTwin = async (companyName) => {
  if (!pgReady) return null;
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
              json_agg(DISTINCT p.*) FILTER (WHERE p.id IS NOT NULL) AS positions,
              json_agg(DISTINCT d.*) FILTER (WHERE d.id IS NOT NULL) AS decisions,
              json_agg(DISTINCT wt.*) FILTER (WHERE wt.id IS NOT NULL) AS triggers
       FROM companies c
       LEFT JOIN positions p ON p.company_id = c.id
       LEFT JOIN decisions d ON d.company_id = c.id
       LEFT JOIN watchlist_triggers wt ON wt.company_id = c.id
       WHERE LOWER(c.name) LIKE LOWER($1) OR LOWER(c.ticker) = LOWER($2)
       GROUP BY c.id
       LIMIT 1`,
      [`%${companyName}%`, companyName]
    );
    return rows[0] || null;
  } catch (e) { console.error('[Twin query error]', e.message); return null; }
};

// ââ Command Queue âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const COMMAND_QUEUE_KEY   = 'mitra:pending_commands';
const COMPLETED_OUTPUT_KEY = 'mitra:completed_outputs';

const ACTION_PATTERNS = /\b(pull|fetch|get me|check|run|draft|send|compile|generate|look up|look into|research|monitor|track|update|schedule|book|confirm|review|analyze|summarize|brief me|market brief|portfolio|inbox|emails?|calendar|trades?|positions?|data|report|news|log|add to)\b/i;
const QUESTION_PATTERNS = /^(what|who|why|when|where|how|is|are|was|were|can you tell|do you know|tell me about|explain)\b/i;
const TWIN_PATTERNS = /\b(log|add|update|record)\b.*(thesis|company|position|decision|target|deal|watchlist)/i;

const isActionRequest = (text) => {
  const t = text.trim();
  if (TWIN_PATTERNS.test(t)) return false; // Digital Twin commands handled directly
  if (QUESTION_PATTERNS.test(t) && !ACTION_PATTERNS.test(t)) return false;
  return ACTION_PATTERNS.test(t);
};

const escapeHtml = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const queueCommand = async (commandText, source = 'voice') => {
  if (!redisReady) return null;
  try {
    const cmd = { id: `cmd_${Date.now()}`, command: commandText.slice(0, 500), status: 'pending_go', source, created_at: new Date().toISOString() };
    await redisClient.rPush(COMMAND_QUEUE_KEY, JSON.stringify(cmd));
    await redisClient.lTrim(COMMAND_QUEUE_KEY, -20, -1);
    await tgSend(`Mitra â\n\nCommand queued: "<b>${escapeHtml(commandText.slice(0, 200))}</b>"\n\nReply <b>GO</b> to execute or <b>STOP</b> to discard.`);
    return cmd.id;
  } catch (e) { return null; }
};

// ââ Telegram ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.SAVITRI_CHAT_ID || '-1003993831052';
const TG_API     = `https://api.telegram.org/bot${TG_TOKEN}`;
let lastUpdateId = 0;

const tgSend = async (text) => {
  if (!TG_TOKEN) return;
  try {
    await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch {}
};

const GO_PATTERNS   = /^go\b|^confirmed?\b|^approved?\b/i;
const ACK_PATTERNS  = /^(good|ok|okay|noted|thanks|thank you|got it|received|perfect|great|done)\s*\.?\s*$/i;
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
  if (ACK_PATTERNS.test(trimmed)) return;
  try {
    const history = await getHistory(chatId, 14);
    const systemPrompt = await buildSystemPrompt();
    const messages = history.length > 0 ? history.map(h => ({ role: h.role, content: h.content })) : [{ role: 'user', content: trimmed }];
    const last = messages[messages.length - 1];
    if (last.role === 'user') last.content = last.content.replace(/@mitra\b/gi, '').replace(/^mitra[,:\s]*/i, '').trim() || last.content;
    const response = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 250, system: systemPrompt, messages });
    const reply = response.content[0].text;
    await saveMessage(chatId, 'assistant', reply);
    await tgSend(reply);
  } catch { await tgSend('Mitra\nError. Please check Cowork.'); }
};

const pollTelegram = async () => {
  if (!TG_TOKEN) return;
  try {
    const params = new URLSearchParams({ limit: '20' });
    if (lastUpdateId > 0) params.set('offset', String(lastUpdateId + 1));
    const res  = await fetch(`${TG_API}/getUpdates?${params}`);
    const data = await res.json();
    if (!data.ok || !data.result?.length) return;
    for (const update of data.result) {
      if (update.update_id > lastUpdateId) lastUpdateId = update.update_id;
      const msg = update.message ?? update.channel_post;
      if (!msg?.text) continue;
      await processMessage(msg.text, msg.message_id, msg.chat?.id ?? TG_CHAT_ID);
    }
    if (lastUpdateId > 0) await fetch(`${TG_API}/getUpdates?offset=${lastUpdateId + 1}&limit=1`);
  } catch {}
};

// ââ System Prompt âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const MITRA_BASE_PROMPT = `You are Mitra Sahai, Digital Associate and Chief of Staff at Savitri Financial Solution Inc. (SFSI).

IDENTITY:
Name: Mitra Sahai. Title: Digital Associate and Chief of Staff. Tone: Ultra-professional, data-driven, Quietly Confident. Never say you are an AI or Claude. Concise 2-4 sentences unless Boss requests detail. Begin every response with "Mitra" on the first line.

THE TEAM:
- Satish Sharma â Boss, CEO, final decision-maker. All permissions flow through him.
- Julieta Sharma (Jing) â Madam Boss, CFO. Financial controls and reporting lead.
- Pradnesh Sharma (Nesh) â The Brains, Investment Specialist. Research authority.

DIGITAL TWIN â v9.0 CAPABILITY:
SFSI now has a live Postgres institutional memory â the Digital Twin. I CAN:
- Query company profiles (thesis, conviction, kill switch, next catalyst)
- Retrieve SFSI positions (entry price, tranches, P&L)
- Pull relationship records (founders, CEOs, analysts)
- Log new thesis, position, and decision records on Nesh's command
- Cross-reference live FMP market data against stored thesis
- Surface pre-earnings notes and post-earnings delta analysis

Current companies in the Twin: ISRG (Position Open), Novo Nordisk (Active Watch), OpenAI (Pre-IPO), Anthropic (Pre-IPO), Cerebras Systems (Pre-IPO).

NESH LOG COMMAND FORMAT:
When Nesh says "Mitra, log thesis for [Company]: [thesis]. Conviction: [1-5]. Kill switch: [condition]." â I parse and write directly to the Digital Twin, then return live market context.

CORE PROTOCOLS:
- NEVER take external action without Boss explicit GO.
- Lead with bottom line, no fluff.
- CC satish@savitrifsi.com on every outbound email. Zero exceptions.
- Never disclose portfolio size or positions externally.
- Investment execution authority: Boss only. Nesh researches, Boss approves and executes on Fidelity.

RESPONSE FORMAT:
- Voice calls: under 60 words, natural spoken language.
- Text/Telegram: 2-4 sentences unless detail requested.
- ISRG Stress Test format: Delta | Nesh Factor | So What.

BUILD: Brain API v10.0 | IBOR Ledger (Phase 2A) + Digital Twin (Postgres) + Conversation Memory (Redis) | 2026-04-20
Voice: Vapi +1 (949) 516-9654`;

const buildSystemPrompt = async () => {
  const ctx = await getGlobalContext();

  // ── Live Digital Twin context from Postgres ──────────────────────────────
  let twinContext = '';
  if (pgReady) {
    try {
      const { rows: positions } = await pool.query(
        `SELECT c.name, c.ticker, c.sector, c.conviction_level, c.thesis, c.kill_switch, c.next_catalyst,
                p.entry_price, p.shares, p.tranche_plan, p.notes as pos_notes
         FROM positions p JOIN companies c ON c.id = p.company_id
         WHERE p.status = 'Open' ORDER BY p.entry_price * p.shares DESC NULLS LAST`
      );
      const { rows: watchlist } = await pool.query(
        `SELECT name, ticker, sector, conviction_level, thesis, kill_switch, next_catalyst
         FROM companies WHERE status NOT IN ('Position Open') ORDER BY conviction_level DESC LIMIT 20`
      );

      twinContext = '\n\n--- DIGITAL TWIN — SFSI LIVE PORTFOLIO & WATCHLIST ---\n';

      if (positions.length > 0) {
        twinContext += `OPEN POSITIONS (${positions.length}):\n`;
        for (const p of positions) {
          const ep = p.entry_price ? `@ $${parseFloat(p.entry_price).toFixed(2)}` : '';
          const shares = p.shares ? `${parseFloat(p.shares).toFixed(3)} shares` : '';
          const thesis = p.thesis && !p.thesis.includes('Thesis Pending') ? ` | ${p.thesis.slice(0, 120)}` : '';
          const kill = p.kill_switch ? ` | Kill switch: ${p.kill_switch.slice(0, 80)}` : '';
          const catalyst = p.next_catalyst ? ` | Next catalyst: ${p.next_catalyst}` : '';
          twinContext += `• ${p.name} (${p.ticker}) | ${p.sector} | ${shares} ${ep} | Conviction: ${p.conviction_level}/5${thesis}${kill}${catalyst}\n`;
        }
      }

      if (watchlist.length > 0) {
        twinContext += `\nWATCHLIST (${watchlist.length} companies):\n`;
        for (const c of watchlist) {
          const thesis = c.thesis && !c.thesis.includes('Thesis Pending') ? ` | ${c.thesis.slice(0, 100)}` : '';
          const kill = c.kill_switch ? ` | Kill: ${c.kill_switch.slice(0, 60)}` : '';
          twinContext += `• ${c.name} (${c.ticker}) | ${c.sector} | Conviction: ${c.conviction_level}/5${thesis}${kill}\n`;
        }
      }

      twinContext += '--- END DIGITAL TWIN ---';
    } catch (e) {
      twinContext = `\n[Digital Twin query error: ${e.message}]`;
    }
  }

  const base = MITRA_BASE_PROMPT + twinContext;
  if (!ctx) return base;
  return `${base}\n\n--- COWORK MEMORY SYNC ---\n${ctx}\n--- END COWORK MEMORY ---`;
};

// ââ Auth ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const MITRA_SYNC_KEY = process.env.MITRA_SYNC_KEY;
const requireKey = (req, res, next) => {
  if (!MITRA_SYNC_KEY) return next();
  if (req.headers['x-mitra-key'] !== MITRA_SYNC_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
};

// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// ROUTES
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// ââ Health ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/', async (req, res) => {
  const ctx = await getGlobalContext();
  const updatedAt = redisReady ? await redisClient.get(CONTEXT_UPDATED_KEY) : null;
  const companyCount = pgReady ? (await pool.query('SELECT COUNT(*) FROM companies')).rows[0].count : 0;
  const positionCount = pgReady ? (await pool.query("SELECT COUNT(*) FROM positions WHERE status='Open'")).rows[0].count : 0;
  res.json({
    status:         'ok',
    version:        '10.0',
    build:          'Digital Twin â Institutional Memory Engine',
    memory: {
      conversation: redisReady ? 'Redis (active)' : 'disabled',
      institutional: pgReady ? `Postgres (${companyCount} companies, ${positionCount} open positions)` : 'disabled â set DATABASE_URL'
    },
    cowork_sync:    ctx.length > 0 ? `active (${ctx.length} chars, synced ${updatedAt || 'unknown'})` : 'not synced',
    twin_companies: pgReady ? parseInt(companyCount) : 0,
    endpoints: {
      voice:         'POST /v1/chat/completions',
      chat:          'POST /ask | POST /chat',
      twin_write:    'POST /log-company | POST /log-thesis | POST /log-position | POST /log-decision',
      twin_read:     'GET /company/:name | GET /portfolio | GET /watchlist',
      ibor_sync:     'POST /v1/sync/portfolio',
      ibor_read:     'GET /v1/portfolio/:account_id | GET /v1/transactions/:account_id | GET /v1/income/:account_id',
      ibor_write:    'POST /v1/log-income',
      memory:        'POST|GET|DELETE /memory/context',
      commands:      'GET /commands/pending | POST /commands/acknowledge | POST /commands/complete'
    }
  });
});

// ââ Digital Twin â WRITE Endpoints âââââââââââââââââââââââââââââââââââââââââââ

// POST /log-thesis â Nesh's primary command
// Body: { name, ticker, thesis, conviction_level, kill_switch, next_catalyst, notes }
app.post('/log-thesis', requireKey, async (req, res) => {
  if (!pgReady) return res.status(503).json({ error: 'Digital Twin not ready â check DATABASE_URL' });
  const { name, ticker, thesis, conviction_level, kill_switch, next_catalyst, notes, added_by = 'Nesh' } = req.body;
  if (!ticker && !name) return res.status(400).json({ error: 'ticker or name required' });

  try {
    // Look up existing record — ticker first (fastest), then by name
    let existing = null;
    if (ticker) {
      existing = await pool.query('SELECT id FROM companies WHERE UPPER(ticker) = UPPER($1)', [ticker]);
    }
    if ((!existing || existing.rows.length === 0) && name) {
      existing = await pool.query('SELECT id FROM companies WHERE LOWER(name) = LOWER($1)', [name]);
    }
    let companyId;

    if (existing && existing.rows.length > 0) {
      // PARTIAL UPDATE — only overwrite fields that are explicitly provided; leave others untouched
      companyId = existing.rows[0].id;
      await pool.query(
        `UPDATE companies SET
         thesis=COALESCE($1,thesis), conviction_level=COALESCE($2,conviction_level),
         kill_switch=COALESCE($3,kill_switch), next_catalyst=COALESCE($4,next_catalyst),
         notes=COALESCE($5,notes), ticker=COALESCE($6,ticker), name=COALESCE($7,name),
         updated_at=NOW() WHERE id=$8`,
        [thesis||null, conviction_level||null, kill_switch||null, next_catalyst||null, notes||null, ticker||null, name||null, companyId]
      );
    } else {
      // New company — name and thesis are required for INSERT
      if (!name || !thesis) return res.status(400).json({ error: 'name and thesis required for new company' });
      const { rows } = await pool.query(
        `INSERT INTO companies (name, ticker, thesis, conviction_level, kill_switch, next_catalyst, notes, added_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [name, ticker || null, thesis, conviction_level || 3, kill_switch || null, next_catalyst || null, notes || null, added_by]
      );
      companyId = rows[0].id;
    }

    // Log the thesis decision
    await pool.query(
      `INSERT INTO decisions (company_id, type, decided_by, approved_by, rationale, outcome)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [companyId, 'Thesis Logged', added_by, 'Pending Boss Review', (thesis||'').slice(0, 500), 'Pending']
    );

    // Cross-reference live market data
    let marketData = null;
    if (ticker) {
      const [quote, news] = await Promise.all([fmpQuote(ticker), fmpNews(ticker, 2)]);
      if (quote) {
        marketData = {
          price: quote.price,
          change_pct: quote.changesPercentage,
          market_cap: quote.marketCap,
          pe: quote.pe,
          week52_high: quote['50DayAvgVolume'] ? null : quote['yearHigh'],
          recent_news: news.slice(0,2).map(n => n.title)
        };
      }
    }

    const response = {
      logged: true,
      company_id: companyId,
      company: name,
      ticker: ticker || 'Pre-IPO',
      thesis_chars: (thesis||'').length,
      conviction: conviction_level || 3,
      market_data: marketData,
      timestamp: new Date().toISOString()
    };

    console.log(`[Twin] Thesis logged: ${name} by ${added_by}`);
    res.json(response);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /log-company â create or update a full company profile
app.post('/log-company', requireKey, async (req, res) => {
  if (!pgReady) return res.status(503).json({ error: 'Digital Twin not ready' });
  const { name, ticker, sector, stage, status, thesis, conviction_level, kill_switch, next_catalyst, notes, added_by = 'Mitra' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const existing = await pool.query('SELECT id FROM companies WHERE LOWER(name) = LOWER($1)', [name]);
    let companyId, action;
    if (existing.rows.length > 0) {
      companyId = existing.rows[0].id;
      await pool.query(
        `UPDATE companies SET ticker=COALESCE($1,ticker), sector=COALESCE($2,sector), stage=COALESCE($3,stage),
         status=COALESCE($4,status), thesis=COALESCE($5,thesis), conviction_level=COALESCE($6,conviction_level),
         kill_switch=COALESCE($7,kill_switch), next_catalyst=COALESCE($8,next_catalyst),
         notes=COALESCE($9,notes), updated_at=NOW() WHERE id=$10`,
        [ticker, sector, stage, status, thesis, conviction_level, kill_switch, next_catalyst, notes, companyId]
      );
      action = 'updated';
    } else {
      const { rows } = await pool.query(
        `INSERT INTO companies (name, ticker, sector, stage, status, thesis, conviction_level, kill_switch, next_catalyst, notes, added_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [name, ticker||null, sector||null, stage||'Public', status||'Active Watch', thesis||null, conviction_level||3, kill_switch||null, next_catalyst||null, notes||null, added_by]
      );
      companyId = rows[0].id;
      action = 'created';
    }
    res.json({ [action]: true, company_id: companyId, company: name, timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /log-position â Boss enters a trade
app.post('/log-position', requireKey, async (req, res) => {
  if (!pgReady) return res.status(503).json({ error: 'Digital Twin not ready' });
  const { company_name, entry_date, entry_price, shares, tranche_plan, notes } = req.body;
  if (!company_name || !entry_price) return res.status(400).json({ error: 'company_name and entry_price required' });
  try {
    const { rows } = await pool.query('SELECT id FROM companies WHERE LOWER(name) LIKE LOWER($1) OR LOWER(ticker) = LOWER($1)', [`%${company_name}%`]);
    if (!rows.length) return res.status(404).json({ error: `Company "${company_name}" not found in Twin. Log company first.` });
    const companyId = rows[0].id;
    const { rows: pos } = await pool.query(
      `INSERT INTO positions (company_id, entry_date, entry_price, shares, tranche_plan, status, notes)
       VALUES ($1,$2,$3,$4,$5,'Open',$6) RETURNING id`,
      [companyId, entry_date || new Date().toISOString().split('T')[0], entry_price, shares || null, tranche_plan ? JSON.stringify(tranche_plan) : null, notes || null]
    );
    await pool.query(
      `INSERT INTO decisions (company_id, type, decided_by, approved_by, rationale, outcome)
       VALUES ($1,'Buy','Boss','Boss',$2,'Confirmed')`,
      [companyId, `Position opened: ${shares || '?'} shares @ $${entry_price}`]
    );
    res.json({ logged: true, position_id: pos[0].id, company: company_name, entry_price, timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /log-decision â governance entry
app.post('/log-decision', requireKey, async (req, res) => {
  if (!pgReady) return res.status(503).json({ error: 'Digital Twin not ready' });
  const { company_name, type, decided_by, approved_by, rationale, outcome } = req.body;
  if (!company_name || !type || !rationale) return res.status(400).json({ error: 'company_name, type, and rationale required' });
  try {
    const { rows } = await pool.query('SELECT id FROM companies WHERE LOWER(name) LIKE LOWER($1) OR LOWER(ticker) = LOWER($1)', [`%${company_name}%`]);
    if (!rows.length) return res.status(404).json({ error: `Company "${company_name}" not found in Twin` });
    const { rows: dec } = await pool.query(
      `INSERT INTO decisions (company_id, type, decided_by, approved_by, rationale, outcome)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [rows[0].id, type, decided_by || 'Boss', approved_by || 'Boss', rationale, outcome || 'Confirmed']
    );
    res.json({ logged: true, decision_id: dec[0].id, company: company_name, type, timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ââ Digital Twin â READ Endpoints âââââââââââââââââââââââââââââââââââââââââââââ

// GET /company/:name â full profile with live market data
app.get('/company/:name', requireKey, async (req, res) => {
  if (!pgReady) return res.status(503).json({ error: 'Digital Twin not ready' });
  try {
    const record = await queryTwin(req.params.name);
    if (!record) return res.status(404).json({ error: `"${req.params.name}" not found in Digital Twin` });

    // Enrich with live FMP data if ticker exists
    let live = null;
    if (record.ticker) {
      const [quote, news, profile] = await Promise.all([
        fmpQuote(record.ticker),
        fmpNews(record.ticker, 3),
        fmpProfile(record.ticker)
      ]);
      if (quote) {
        live = {
          price:        quote.price,
          change:       quote.change,
          change_pct:   quote.changesPercentage,
          day_high:     quote.dayHigh,
          day_low:      quote.dayLow,
          week52_high:  quote.yearHigh,
          week52_low:   quote.yearLow,
          market_cap_b: quote.marketCap ? (quote.marketCap / 1e9).toFixed(2) : null,
          pe:           quote.pe,
          eps:          quote.eps,
          volume:       quote.volume,
          avg_volume:   quote.avgVolume,
          recent_news:  news.map(n => ({ title: n.title, date: n.publishedDate }))
        };
      }
    }

    res.json({ ...record, live_market_data: live, retrieved_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /portfolio â all open positions
app.get('/portfolio', requireKey, async (req, res) => {
  if (!pgReady) return res.status(503).json({ error: 'Digital Twin not ready' });
  try {
    const { rows } = await pool.query(
      `SELECT c.name, c.ticker, c.sector, c.conviction_level, c.status,
              p.entry_date, p.entry_price, p.shares, p.tranche_plan, p.notes AS position_notes
       FROM positions p
       JOIN companies c ON c.id = p.company_id
       WHERE p.status = 'Open'
       ORDER BY p.entry_date DESC`
    );

    // Enrich with live prices
    const enriched = await Promise.all(rows.map(async (row) => {
      if (!row.ticker) return { ...row, current_price: null, unrealized_pnl: null };
      const quote = await fmpQuote(row.ticker);
      if (!quote) return { ...row, current_price: null, unrealized_pnl: null };
      const cost_basis = parseFloat(row.entry_price) * parseFloat(row.shares);
      const current_value = quote.price * parseFloat(row.shares);
      return {
        ...row,
        current_price:  quote.price,
        change_pct:     quote.changesPercentage,
        cost_basis:     cost_basis.toFixed(2),
        current_value:  current_value.toFixed(2),
        unrealized_pnl: (current_value - cost_basis).toFixed(2),
        unrealized_pct: (((current_value - cost_basis) / cost_basis) * 100).toFixed(2)
      };
    }));

    res.json({ open_positions: enriched, count: enriched.length, retrieved_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /watchlist â active triggers
app.get('/watchlist', requireKey, async (req, res) => {
  if (!pgReady) return res.status(503).json({ error: 'Digital Twin not ready' });
  try {
    const { rows } = await pool.query(
      `SELECT c.name, c.ticker, c.stage, c.next_catalyst, c.conviction_level,
              wt.trigger_type, wt.trigger_condition, wt.alert_channel, wt.is_active
       FROM watchlist_triggers wt
       JOIN companies c ON c.id = wt.company_id
       WHERE wt.is_active = true
       ORDER BY c.name`
    );
    res.json({ watchlist: rows, count: rows.length, retrieved_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /twin/summary â overview of all companies in the twin
app.get('/twin/summary', requireKey, async (req, res) => {
  if (!pgReady) return res.status(503).json({ error: 'Digital Twin not ready' });
  try {
    const { rows } = await pool.query(
      `SELECT name, ticker, sector, stage, status, conviction_level, next_catalyst, updated_at
       FROM companies ORDER BY stage, conviction_level DESC`
    );
    res.json({ companies: rows, total: rows.length, retrieved_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ââ Memory Context Endpoints ââââââââââââââââââââââââââââââââââââââââââââââââââ
app.post('/memory/context', requireKey, async (req, res) => {
  const { context } = req.body;
  if (!context) return res.status(400).json({ error: 'context required' });
  if (context.length > 8000) return res.status(400).json({ error: 'context too large (max 8000 chars)' });
  const saved = await setGlobalContext(context);
  res.json({ saved, chars: context.length, timestamp: new Date().toISOString() });
});

app.get('/memory/context', requireKey, async (req, res) => {
  const context   = await getGlobalContext();
  const updatedAt = redisReady ? await redisClient.get(CONTEXT_UPDATED_KEY) : null;
  res.json({ hasContext: context.length > 0, chars: context.length, updatedAt, preview: context.slice(0, 300) });
});

app.delete('/memory/context', requireKey, async (req, res) => {
  await setGlobalContext('');
  res.json({ cleared: true, timestamp: new Date().toISOString() });
});

// ââ Command Queue Endpoints âââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/commands/pending', requireKey, async (req, res) => {
  if (!redisReady) return res.json({ commands: [] });
  try {
    const entries  = await redisClient.lRange(COMMAND_QUEUE_KEY, 0, -1);
    const commands = entries.map(e => JSON.parse(e)).filter(c => c.status === 'pending_go' || c.status === 'go_received');
    res.json({ commands, total: entries.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/commands/acknowledge', requireKey, async (req, res) => {
  const { commandId } = req.body;
  if (!commandId || !redisReady) return res.status(400).json({ error: 'commandId required' });
  try {
    const entries    = await redisClient.lRange(COMMAND_QUEUE_KEY, 0, -1);
    let updated      = false;
    const newEntries = entries.map(e => { const c = JSON.parse(e); if (c.id === commandId && c.status === 'pending_go') { c.status = 'go_received'; updated = true; return JSON.stringify(c); } return e; });
    if (updated) { await redisClient.del(COMMAND_QUEUE_KEY); for (const e of newEntries) await redisClient.rPush(COMMAND_QUEUE_KEY, e); }
    res.json({ acknowledged: updated, commandId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/commands/complete', requireKey, async (req, res) => {
  const { commandId, output, summary } = req.body;
  if (!commandId || !output || !redisReady) return res.status(400).json({ error: 'commandId and output required' });
  try {
    const result = { commandId, output: output.slice(0, 8000), summary: (summary || output).slice(0, 500), completed_at: new Date().toISOString() };
    await redisClient.rPush(COMPLETED_OUTPUT_KEY, JSON.stringify(result));
    await redisClient.lTrim(COMPLETED_OUTPUT_KEY, -10, -1);
    const entries    = await redisClient.lRange(COMMAND_QUEUE_KEY, 0, -1);
    const newEntries = entries.map(e => { const c = JSON.parse(e); if (c.id === commandId) { c.status = 'complete'; return JSON.stringify(c); } return e; });
    await redisClient.del(COMMAND_QUEUE_KEY); for (const e of newEntries) await redisClient.rPush(COMMAND_QUEUE_KEY, e);
    const existingCtx = await getGlobalContext();
    await setGlobalContext((existingCtx + `\n\n[OUTPUT â ${result.completed_at}]\n${result.summary}`).slice(-8000));
    await tgSend(`Mitra â\n\nExecution complete.\n\n${escapeHtml(result.summary)}\n\nCall Mitra for verbal brief.`);
    res.json({ saved: true, commandId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/commands/:id', requireKey, async (req, res) => {
  if (!redisReady) return res.status(503).json({ error: 'Redis not ready' });
  try {
    const entries    = await redisClient.lRange(COMMAND_QUEUE_KEY, 0, -1);
    const newEntries = entries.map(e => { const c = JSON.parse(e); if (c.id === req.params.id) { c.status = 'cancelled'; return JSON.stringify(c); } return e; });
    await redisClient.del(COMMAND_QUEUE_KEY); for (const e of newEntries) await redisClient.rPush(COMMAND_QUEUE_KEY, e);
    res.json({ cancelled: true, commandId: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ââ /ask ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.post('/ask', async (req, res) => {
  const { question, chatId = 'ask-session' } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });
  try {
    await saveMessage(chatId, 'user', question);
    const history = await getHistory(chatId, 14);
    const system  = await buildSystemPrompt();
    const messages = history.length > 0 ? history.map(h => ({ role: h.role, content: h.content })) : [{ role: 'user', content: question }];
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, system, messages });
    const reply = r.content[0].text;
    await saveMessage(chatId, 'assistant', reply);
    res.json({ answer: reply, chatId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ââ /chat âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.post('/chat', async (req, res) => {
  const { messages, chatId = 'chat-session' } = req.body;
  const last = messages?.[messages.length - 1]?.content || '';
  if (!last) return res.status(400).json({ error: 'no message content' });
  try {
    await saveMessage(chatId, 'user', last);
    const history = await getHistory(chatId, 14);
    const system  = await buildSystemPrompt();
    const msgs    = history.length > 0 ? history.map(h => ({ role: h.role, content: h.content })) : [{ role: 'user', content: last }];
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, system, messages: msgs });
    const reply = r.content[0].text;
    await saveMessage(chatId, 'assistant', reply);
    res.json({ response: reply, chatId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ââ /v1/chat/completions â Vapi voice âââââââââââââââââââââââââââââââââââââââââ
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, stream } = req.body;
    const chatId = 'boss-voice-v2';
    const msgs = messages.filter(m => m.role !== 'system').map(m => ({
      role:    m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : m.content?.[0]?.text || ''
    }));
    if (!msgs.length) msgs.push({ role: 'user', content: 'Hello' });

    const lastUser = [...msgs].reverse().find(m => m.role === 'user');
    if (lastUser) await saveMessage(chatId, 'user', lastUser.content);

    let commandQueued = false;
    if (lastUser && isActionRequest(lastUser.content)) {
      const cmdId = await queueCommand(lastUser.content, 'voice');
      if (cmdId) commandQueued = true;
    }

    const history   = await getHistory(chatId, 14);
    const finalMsgs = history.length > 1 ? history.map(h => ({ role: h.role, content: h.content })) : msgs;
    const system    = await buildSystemPrompt();

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const sr = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, system, messages: finalMsgs, stream: true });
      const id = `chatcmpl-${Date.now()}`;
      let fullReply = '';
      for await (const ev of sr) {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          fullReply += ev.delta.text;
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'mitra-brain-v9', choices: [{ index: 0, delta: { role: 'assistant', content: ev.delta.text }, finish_reason: null }] })}\n\n`);
        }
        if (ev.type === 'message_stop') {
          await saveMessage(chatId, 'assistant', fullReply);
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'mitra-brain-v9', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    } else {
      const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, system, messages: finalMsgs });
      const reply = r.content[0].text;
      await saveMessage(chatId, 'assistant', reply);
      res.json({ id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: 'mitra-brain-v9', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] });
    }
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ââ Start âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\nMitra Brain API v10.0 â Digital Twin | Institutional Memory Engine`);
  console.log(`SFSI Chief of Staff | savitrifsi.com`);
  console.log(`Port: ${PORT} | ${new Date().toISOString()}\n`);
  await initRedis();
  await initPostgres();
  // Telegram polling: enable when Boss directs
  // if (TG_TOKEN) { pollTelegram(); setInterval(pollTelegram, 30000); }
});
