import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from 'redis';
import pg from 'pg';
import { fetchDriveMemory } from './google_drive.js';

const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ------------ FMP Market Data Helper ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
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

// ------------ Redis (Conversation Memory) ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const redisClient = process.env.REDIS_URL ? createClient({ url: process.env.REDIS_URL }) : null;
let redisReady = false;

const initRedis = async () => {
  if (!redisClient) { console.log('[Redis] No REDIS_URL ------ conversation memory disabled'); return; }
  try {
    redisClient.on('error', (e) => console.error('[Redis]', e.message));
    await redisClient.connect();
    redisReady = true;
    console.log('[Redis] Connected ------ conversation memory ACTIVE');
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

// ------------ Global Context (Cowork <> Brain sync) ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
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
const appendToGlobalContext = async (entry) => {
  try {
    if (!redisReady) return;
    const cur = await redisClient.get(GLOBAL_CONTEXT_KEY) || '';
    const ts = new Date().toISOString().slice(0, 16);
    const appended = cur + '\n[GLOBAL ' + ts + '] ' + entry;
    const trimmed = appended.length > 7400 ? appended.slice(-7400) : appended;
    await redisClient.set(GLOBAL_CONTEXT_KEY, trimmed);
    await redisClient.set(CONTEXT_UPDATED_KEY, new Date().toISOString());
  } catch (e) { console.error('appendToGlobalContext:', e.message); }
};


// ------------ Postgres (Digital Twin ------ Institutional Memory) ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;
let pgReady = false;

const initPostgres = async () => {
  if (!pool) { console.log('[Postgres] No DATABASE_URL ------ Savitri Portfolio Database disabled'); return; }
  try {
    await pool.query('SELECT 1');
    pgReady = true;
    console.log('[Postgres] Connected ------ Savitri Portfolio Database ACTIVE');
    await createSchema();
    await seedIfEmpty();
    await seedBrokerageData();
  } catch (e) { console.error('[Postgres] Init error:', e.message); }
};

const createSchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory (
      file_name   TEXT PRIMARY KEY,
      content     TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS voice_learnings (
        id          SERIAL PRIMARY KEY,
        content     TEXT NOT NULL,
        source      VARCHAR(50) DEFAULT 'voice',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        applied     BOOLEAN DEFAULT false
      );


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


    -- ------ Savitri Portfolio Database --- Accounting Layer ---------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS accounts (
      account_id    TEXT PRIMARY KEY,
      account_name  TEXT NOT NULL,
      broker        TEXT DEFAULT 'Fidelity',
      account_type  TEXT DEFAULT 'Brokerage',
      owner         TEXT DEFAULT 'Satish Sharma',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS securities (
      sid              SERIAL PRIMARY KEY,
      ticker           TEXT NOT NULL UNIQUE,
      company_id       INTEGER REFERENCES companies(id),
      instrument_type  TEXT DEFAULT 'EQUITY',
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS security_ticker_history (
      id             SERIAL PRIMARY KEY,
      sid            INTEGER REFERENCES securities(sid),
      ticker         TEXT NOT NULL,
      effective_from DATE NOT NULL,
      effective_to   DATE,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tax_lots (
      lot_id              SERIAL PRIMARY KEY,
      sid                 INTEGER REFERENCES securities(sid),
      account_id          TEXT REFERENCES accounts(account_id),
      acquisition_date    DATE NOT NULL,
      quantity            NUMERIC(18,6) NOT NULL,
      remaining_quantity  NUMERIC(18,6) NOT NULL,
      cost_basis_per_share NUMERIC(18,6) NOT NULL,
      is_open             BOOLEAN DEFAULT TRUE,
      lot_method          TEXT DEFAULT 'SPEC_ID',
      notes               TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS lot_transactions (
      id               SERIAL PRIMARY KEY,
      lot_id           INTEGER REFERENCES tax_lots(lot_id),
      transaction_type TEXT NOT NULL,
      quantity         NUMERIC(18,6) NOT NULL,
      price_per_share  NUMERIC(18,6),
      total_amount     NUMERIC(18,2),
      transaction_date DATE NOT NULL,
      notes            TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tax_lots_open    ON tax_lots(sid, account_id) WHERE is_open = TRUE;
    CREATE INDEX IF NOT EXISTS idx_tax_lots_account ON tax_lots(account_id, acquisition_date);
    -- Seed Fidelity account if not exists
    INSERT INTO accounts (account_id, account_name, broker, account_type)
    VALUES ('15237882', 'Savitri FSI --- Fidelity Brokerage', 'Fidelity', 'Brokerage')
    ON CONFLICT (account_id) DO NOTHING;  `);
  console.log('[Postgres] Schema verified ------ 5 tables ready');
};

// ------------ Seed Data ------ Day 1 Digital Twin Records ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const seedIfEmpty = async () => {
  const { rows } = await pool.query('SELECT COUNT(*) FROM companies');
  if (parseInt(rows[0].count) > 0) {
    console.log(`[Postgres] Savitri Portfolio Database has ${rows[0].count} companies ------ skipping seed`);
    return;
  }
  console.log('[Postgres] Seeding Savitri Portfolio Database with 5 founding records...');

  const companies = [
    {
      name: 'Intuitive Surgical',
      ticker: 'ISRG',
      sector: 'Medical Devices',
      stage: 'Public',
      status: 'Position Open',
      thesis: 'Structural monopoly on robotic-assisted surgery. The da Vinci system creates a razor-and-blade revenue model ------ hospitals locked in via training, consumables, and multi-year service contracts. Procedure volume growing 12-15% annually is the primary alpha driver. Global expansion (OUS procedures +20% YoY) provides a second growth engine independent of US hospital capex cycles.',
      conviction_level: 4,
      kill_switch: 'Competition narrows da Vinci gross margin below 60% for two consecutive quarters; FDA approves a competing system at comparable clinical capability at 30%+ lower cost; US procedure growth falls below 8% for two consecutive quarters; management guidance cut materially on FY26 revenue.',
      next_catalyst: 'Q1 2026 Earnings ------ April 21, 2026. Consensus: EPS $2.08, Revenue $2.61B.',
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
      thesis: 'GLP-1 market leader. Ozempic and Wegovy create durable revenue with strong IP protection through 2031. Global obesity epidemic provides multi-decade demand tailwind. Research in progress ------ Nesh developing full thesis.',
      conviction_level: 3,
      kill_switch: 'Eli Lilly tirzepatide gains >40% market share in obesity indication; GLP-1 cardiovascular benefit claims challenged by FDA; reimbursement coverage materially restricted by major US payers.',
      next_catalyst: 'Q1 2026 Earnings ------ upcoming. Watch Wegovy supply normalization and US obesity coverage expansion.',
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
      thesis: 'Safety-first LLM architecture with Constitutional AI creating differentiated enterprise positioning. Claude API gaining enterprise share against GPT-4 on reliability and context window. Amazon investment ($4B) provides compute and distribution. LLM price war primary risk ------ commoditization compresses margin before IPO.',
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
      next_catalyst: 'Q2 2026 IPO window (estimated). S-1 filing will be the primary intelligence trigger ------ watch for revenue growth rate, customer concentration, and gross margin.',
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
          'Buy ------ Tranche 1',
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

// ------------ Digital Twin Query Helper ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
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

// ------------ Command Queue ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
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
    await tgSend(`Mitra ------\n\nCommand queued: "<b>${escapeHtml(commandText.slice(0, 200))}</b>"\n\nReply <b>GO</b> to execute or <b>STOP</b> to discard.`);
    return cmd.id;
  } catch (e) { return null; }
};

// ------------ Telegram ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
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
    let _basePrompt = await buildSystemPrompt();
    const _dm = await fetchDriveMemory();
    const systemPrompt = _dm ? _dm + '\n\n' + _basePrompt : _basePrompt;
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

// ------------ System Prompt ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const MITRA_BASE_PROMPT = `You are Mitra Sahai, Digital Associate and Chief of Staff at Savitri Financial Solution Inc. (SFSI).

IDENTITY:
Name: Mitra Sahai. Title: Digital Associate and Chief of Staff. Tone: Ultra-professional, data-driven, Quietly Confident. Never say you are an AI or Claude. Concise 2-4 sentences unless Boss requests detail. Begin every response with "Mitra" on the first line.

THE TEAM:
- Satish Sharma ------ Boss, CEO, final decision-maker. All permissions flow through him.
- Julieta Sharma (Jing) ------ Madam Boss, CFO. Financial controls and reporting lead.
- Pradnesh Sharma (Nesh) ------ The Brains, Investment Specialist. Research authority.

SAVITRI PORTFOLIO DATABASE --- v11.1 CAPABILITY:
SFSI now has a live Postgres institutional memory ------ the Savitri Portfolio Database. I CAN:
- Query company profiles (thesis, conviction, kill switch, next catalyst)
- Retrieve SFSI positions (entry price, tranches, P&L)
- Pull relationship records (founders, CEOs, analysts)
- Log new thesis, position, and decision records on Nesh's command
- Cross-reference live FMP market data against stored thesis
- Surface pre-earnings notes and post-earnings delta analysis

Current companies in the Twin: ISRG (Position Open), Novo Nordisk (Active Watch), OpenAI (Pre-IPO), Anthropic (Pre-IPO), Cerebras Systems (Pre-IPO).

NESH LOG COMMAND FORMAT:
When Nesh says "Mitra, log thesis for [Company]: [thesis]. Conviction: [1-5]. Kill switch: [condition]." ------ I parse and write directly to the Digital Twin, then  market context.

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

BUILD: Savitri Portfolio Database v11.0 | Companies (Intelligence) + Tax Lots (Accounting) + Conversation Memory (Redis) | 2026-04-21
Voice: Vapi +1 (949) 516-9654`;

const buildSystemPrompt = async () => {
  const ctx = await getGlobalContext();

  // ------ Live Digital Twin context from Postgres ------------------------------------------------------------------------------------------
  let twinContext = '';
  if (pgReady) {
    var memRows = await pool.query('SELECT file_name, content FROM memory ORDER BY updated_at DESC').catch(()=>({rows:[]}));
      var memorySection = memRows.rows.length > 0 ? memRows.rows.map(r => r.content).join('\n\n---\n\n').slice(0, 9000) : '';

  try {
            const { rows: positions } = await pool.query(
        `SELECT agg.ticker,
                COALESCE(c.name, agg.ticker) AS name,
                c.sector, c.conviction_level, c.thesis, c.kill_switch, c.next_catalyst,
                agg.shares, agg.avg_cost, agg.total_cost_basis, agg.first_acquired
         FROM (
           SELECT s.ticker,
                  SUM(tl.remaining_quantity) AS shares,
                  AVG(tl.cost_basis_per_share) AS avg_cost,
                  SUM(tl.remaining_quantity * tl.cost_basis_per_share) AS total_cost_basis,
                  MIN(tl.acquisition_date) AS first_acquired
           FROM tax_lots tl
           JOIN securities s ON s.sid = tl.sid
           WHERE tl.account_id = '15237882' AND tl.is_open = TRUE
           GROUP BY s.ticker
         ) agg
         LEFT JOIN companies c ON UPPER(c.ticker) = UPPER(agg.ticker)
         ORDER BY agg.total_cost_basis DESC NULLS LAST`
      );
      const { rows: watchlist } = await pool.query(
        `SELECT name, ticker, sector, conviction_level, thesis, kill_switch, next_catalyst
         FROM companies WHERE status NOT IN ('Position Open') ORDER BY conviction_level DESC LIMIT 20`
      );

      twinContext = '\n\n--- DIGITAL TWIN --- SFSI LIVE PORTFOLIO & WATCHLIST ---\n';

      if (positions.length > 0) {
        twinContext += `OPEN POSITIONS (${positions.length}):\n`;
        for (const p of positions) {
          const shares = p.shares ? `${parseFloat(p.shares).toFixed(3)} shares` : '';
          const cost = p.avg_cost ? `@ $${parseFloat(p.avg_cost).toFixed(2)} avg` : '';
          const total = p.total_cost_basis ? `($${Math.round(parseFloat(p.total_cost_basis)).toLocaleString()} invested)` : '';
          const thesis = p.thesis && !p.thesis.includes('Thesis Pending') ? ` | ${p.thesis.slice(0, 120)}` : '';
          const kill = p.kill_switch ? ` | Kill switch: ${p.kill_switch.slice(0, 80)}` : '';
          const catalyst = p.next_catalyst ? ` | Next catalyst: ${p.next_catalyst}` : '';
          twinContext += `--- ${p.name} (${p.ticker}) | ${p.sector || 'N/A'} | ${shares} ${cost} ${total} | Conviction: ${p.conviction_level || '?'}/5${thesis}${kill}${catalyst}\n`;
        }
      }

      if (watchlist.length > 0) {
        twinContext += `\nWATCHLIST (${watchlist.length} companies):\n`;
        for (const c of watchlist) {
          const thesis = c.thesis && !c.thesis.includes('Thesis Pending') ? ` | ${c.thesis.slice(0, 100)}` : '';
          const kill = c.kill_switch ? ` | Kill: ${c.kill_switch.slice(0, 60)}` : '';
          twinContext += `--- ${c.name} (${c.ticker}) | ${c.sector} | Conviction: ${c.conviction_level}/5${thesis}${kill}\n`;
        }
      }

      twinContext += '--- END DIGITAL TWIN ---';
    } catch (e) {
      twinContext = `\n[Digital Twin query error: ${e.message}]`;
    }
  }

  const base = MITRA_BASE_PROMPT + twinContext;
  if (!ctx) return base;
  return `${base}${memorySection ? '\n\n=== SFSI MEMORY ===\n' + memorySection + '\n=== END MEMORY ===' : ''}\n\n--- COWORK MEMORY SYNC ---\n${ctx}\n--- END COWORK MEMORY ---`;
};

// ------------ Auth ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const MITRA_SYNC_KEY = process.env.MITRA_SYNC_KEY;
const requireKey = (req, res, next) => {
  if (!MITRA_SYNC_KEY) return next();
  if (req.headers['x-mitra-key'] !== MITRA_SYNC_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ROUTES
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// ------------ Health ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
app.get('/', async (req, res) => {
  const ctx = await getGlobalContext();
  const updatedAt = redisReady ? await redisClient.get(CONTEXT_UPDATED_KEY) : null;
  const companyCount = pgReady ? (await pool.query('SELECT COUNT(*) FROM companies')).rows[0].count : 0;
  const positionCount = pgReady ? (await pool.query("SELECT COUNT(*) FROM positions WHERE status='Open'")).rows[0].count : 0;
  res.json({
    status:         'ok',
    version:        '11.1',
    build:          'Savitri Portfolio Database v11.1',
    memory: {
      conversation: redisReady ? 'Redis (active)' : 'disabled',
      institutional: pgReady ? `Postgres (${companyCount} companies, ${positionCount} open positions)` : 'disabled ------ set DATABASE_URL'
    },
    cowork_sync:    ctx.length > 0 ? `active (${ctx.length} chars, synced ${updatedAt || 'unknown'})` : 'not synced',
    twin_companies: pgReady ? parseInt(companyCount) : 0,
    endpoints: {
      voice:         'POST /v1/chat/completions',
      chat:          'POST /ask | POST /chat',


      ibor_sync:     'POST /v1/sync/portfolio',
      portfolio:     'GET /v1/portfolio/:account_id | GET /v1/transactions/:account_id | GET /v1/income/:account_id',
      portfolio_write: 'POST /v1/sync/portfolio | POST /v1/log-income',
      memory:         'POST|GET|DELETE /memory/context',
      commands:       'GET /commands/pending | POST /commands/acknowledge | POST /commands/complete'
    }
  });
});

// ------ Savitri Portfolio Database --- GET Endpoints ------------------------------------------------------------------------------------------

// GET /v1/portfolio/:account_id --- open lots with intelligence context
app.get('/v1/portfolio/:account_id', requireKey, async (req, res) => {
  if (!pgReady) return res.status(503).json({ error: 'Savitri Portfolio Database not ready' });
  const { account_id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT s.ticker, c.name, c.sector, c.conviction_level, c.thesis, c.kill_switch, c.next_catalyst,
              SUM(tl.remaining_quantity) AS shares,
              AVG(tl.cost_basis_per_share) AS avg_cost,
              SUM(tl.remaining_quantity * tl.cost_basis_per_share) AS total_cost_basis,
              MIN(tl.acquisition_date) AS first_acquired
       FROM tax_lots tl
       JOIN securities s ON s.sid = tl.sid
       LEFT JOIN companies c ON UPPER(c.ticker) = UPPER(s.ticker)
       WHERE tl.account_id = $1 AND tl.is_open = TRUE
       GROUP BY s.ticker, c.name, c.sector, c.conviction_level, c.thesis, c.kill_switch, c.next_catalyst
       ORDER BY SUM(tl.remaining_quantity * tl.cost_basis_per_share) DESC NULLS LAST`,
      [account_id]
    );
    const enriched = await Promise.all(rows.map(async (row) => {
      const quote = await fmpQuote(row.ticker);
      if (!quote) return { ...row, current_price: null, market_value: null, unrealized_pnl: null };
      const marketValue = quote.price * parseFloat(row.shares);
      const costBasis   = parseFloat(row.total_cost_basis);
      return {
        ...row,
        current_price:  quote.price,
        change_pct:     quote.changesPercentage,
        market_value:   marketValue.toFixed(2),
        unrealized_pnl: (marketValue - costBasis).toFixed(2),
        unrealized_pct: costBasis > 0 ? (((marketValue - costBasis) / costBasis) * 100).toFixed(2) : null
      };
    }));
    res.json({ account_id, positions: enriched, count: enriched.length, retrieved_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /v1/transactions/:account_id --- transaction history from lot_transactions
app.get('/v1/transactions/:account_id', requireKey, async (req, res) => {
  if (!pgReady) return res.status(503).json({ error: 'Savitri Portfolio Database not ready' });
  const { account_id } = req.params;
  const limit = parseInt(req.query.limit) || 100;
  try {
    const { rows } = await pool.query(
      `SELECT lt.lot_id, s.ticker, lt.transaction_type, lt.quantity, lt.price_per_share,
              lt.total_amount, lt.transaction_date, lt.notes
       FROM lot_transactions lt
       JOIN tax_lots tl ON tl.lot_id = lt.lot_id
       JOIN securities s ON s.sid = tl.sid
       WHERE tl.account_id = $1
       ORDER BY lt.transaction_date DESC
       LIMIT $2`,
      [account_id, limit]
    );
    res.json({ account_id, transactions: rows, count: rows.length, retrieved_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ------------ Memory Context Endpoints -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
app.post('/memory/context', requireKey, async (req, res) => {
  const { context } = req.body;
  if (!context) return res.status(400).json({ error: 'context required' });
  if (context.length > 8000) return res.status(400).json({ error: 'context too large (max 8000 chars)' });
  const saved = await setGlobalContext(context);
  res.json({ saved, chars: context.length, timestamp: new Date().toISOString() });
});

// --- Postgres Memory Sync Endpoint ---
app.post('/v1/sync/memory', async (req, res) => {
  const key = req.headers['x-mitra-key'];
  if (key !== (process.env.MITRA_SYNC_KEY || 'sfsi-mitra-sync-2026')) return res.status(401).json({error:'unauthorized'});
  const { files } = req.body;
  if (!Array.isArray(files) || files.length === 0) return res.status(400).json({error:'files array required'});
  try {
    let synced = 0;
    for (const f of files) {
      if (!f.file_name || !f.content) continue;
      await pool.query(
        'INSERT INTO memory (file_name, content, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (file_name) DO UPDATE SET content=$2, updated_at=NOW()',
        [f.file_name, f.content]
      );
      synced++;
    }
    res.json({status:'ok', synced, timestamp: new Date().toISOString()});
  } catch(e) {
    res.status(500).json({error: e.message});
  }
});

app.post('/v1/voice/learning', async (req, res) => {
  const key = req.headers['x-mitra-key'];
  if (key !== (process.env.MITRA_SYNC_KEY || 'sfsi-mitra-sync-2026')) return res.status(401).json({error:'unauthorized'});
  const { content, source } = req.body;
  if (!content) return res.status(400).json({error:'content required'});
  try {
    await pool.query('INSERT INTO voice_learnings (content, source) VALUES ($1, $2)', [content, source || 'voice']);
    res.json({status:'ok', message:'learning saved'});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/v1/voice/learnings/pending', async (req, res) => {
  const key = req.headers['x-mitra-key'];
  if (key !== (process.env.MITRA_SYNC_KEY || 'sfsi-mitra-sync-2026')) return res.status(401).json({error:'unauthorized'});
  try {
    const result = await pool.query('SELECT id, content, source, created_at FROM voice_learnings WHERE applied = false ORDER BY created_at ASC');
    res.json({status:'ok', count: result.rows.length, learnings: result.rows});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/v1/voice/learnings/apply', async (req, res) => {
  const key = req.headers['x-mitra-key'];
  if (key !== (process.env.MITRA_SYNC_KEY || 'sfsi-mitra-sync-2026')) return res.status(401).json({error:'unauthorized'});
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({error:'ids array required'});
  try {
    await pool.query('UPDATE voice_learnings SET applied = true WHERE id = ANY($1)', [ids]);
    res.json({status:'ok', applied: ids.length});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ── /v1/smoke — permanent health check (build gate + Railway health check URL)
app.get('/v1/smoke', async (req, res) => {
  try {
    await pool.query('SELECT 1 FROM voice_learnings LIMIT 1');
    const hasKey = !!process.env.ANTHROPIC_API_KEY;
    res.json({ status: 'ok', db: 'connected', anthropic: hasKey ? 'present' : 'MISSING', ts: new Date().toISOString() });
  } catch(e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
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

// ------------ Command Queue Endpoints ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
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
    await setGlobalContext((existingCtx + `\n\n[OUTPUT ------ ${result.completed_at}]\n${result.summary}`).slice(-8000));
    await tgSend(`Mitra ------\n\nExecution complete.\n\n${escapeHtml(result.summary)}\n\nCall Mitra for verbal brief.`);
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

// ------------ /ask ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
app.post('/ask', async (req, res) => {
  const { question, chatId = 'ask-session' } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });
  try {
    await saveMessage(chatId, 'user', question);
    const history = await getHistory(chatId, 14);
    let _basePrompt = await buildSystemPrompt();
    const _dm = await fetchDriveMemory();
    const system = _dm ? _dm + '\n\n' + _basePrompt : _basePrompt;
    const messages = history.length > 0 ? history.map(h => ({ role: h.role, content: h.content })) : [{ role: 'user', content: question }];
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, system, messages });
    const reply = r.content[0].text;
    await saveMessage(chatId, 'assistant', reply);
    res.json({ answer: reply, chatId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ------------ /chat ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
app.post('/chat', async (req, res) => {
  const { messages, chatId = 'chat-session' } = req.body;
  const last = messages?.[messages.length - 1]?.content || '';
  if (!last) return res.status(400).json({ error: 'no message content' });
  try {
    await saveMessage(chatId, 'user', last);
    const history = await getHistory(chatId, 14);
    let _basePrompt = await buildSystemPrompt();
    const _dm = await fetchDriveMemory();
    const system = _dm ? _dm + '\n\n' + _basePrompt : _basePrompt;
    const msgs    = history.length > 0 ? history.map(h => ({ role: h.role, content: h.content })) : [{ role: 'user', content: last }];
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, system, messages: msgs });
    const reply = r.content[0].text;
    await saveMessage(chatId, 'assistant', reply);
    res.json({ response: reply, chatId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ------------ /v1/chat/completions ------ Vapi voice -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
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
    let _basePrompt = await buildSystemPrompt();
    const _dm = await fetchDriveMemory();
    const system = _dm ? _dm + '\n\n' + _basePrompt : _basePrompt;

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
      // [BIDIR] Strip [REMEMBER:...] markers, save to voice_learnings
      const _remMatches = reply.match(/\[REMEMBER:\s*([^\]]+)\]/g) || [];
      for (const _m of _remMatches) {
        const _fact = _m.replace(/^\[REMEMBER:\s*/,'').replace(/\]$/,'').trim();
        pool.query('INSERT INTO voice_learnings (content, source) VALUES ($1, $2)', [_fact, 'voice-auto']).catch(()=>{});
      }
      const cleanReply = reply.replace(/\s*\[REMEMBER:[^\]]+\]/g, '').trim();
      await saveMessage(chatId, 'assistant', reply);
      if (redisReady) appendToGlobalContext('VOICE: ' + (lastUser && lastUser.content ? lastUser.content : '').slice(0, 150) + ' => ' + (reply || '').slice(0, 150)).catch(() => {});

      res.json({ id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: 'mitra-brain-v9', choices: [{ index: 0, message: { role: 'assistant', content: cleanReply }, finish_reason: 'stop' }] });
    }
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ Start ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ
const PORT = process.env.PORT || 3000;


app.listen(PORT, async () => {
  console.log(`\nMitra Brain API v11.1 Ã¢ÂÂ Savitri Portfolio Database | Institutional Memory`);
  console.log(`SFSI Chief of Staff | savitrifsi.com`);
  console.log(`Port: ${PORT} | ${new Date().toISOString()}\n`);
  await initRedis();
  await initPostgres();
  // Telegram polling: LIVE Ã¢ÂÂ enabled 2026-04-21
  if (TG_TOKEN) { pollTelegram(); setInterval(pollTelegram, 30000); } // Enabled 2026-04-21 Ã¢ÂÂ Global Mitra live on Telegram
});
