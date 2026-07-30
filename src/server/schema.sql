-- UUID text primary keys (not incremental) so ids aren't enumerable/IDOR-prone.
-- Ids are generated in the app layer with crypto.randomUUID().

-- One ICP search. Sourcing and enrichment both run as queued jobs, so a run is
-- the durable record the UI polls and the job posts progress back to.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  -- The natural-language ICP, or the domain when the user chose "use my domain".
  icp_prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|sourcing|enriching|done|failed
  lead_count INTEGER NOT NULL DEFAULT 0,
  -- Running total from the attempt ledger; shown as "what this search cost you".
  credits_spent INTEGER NOT NULL DEFAULT 0,
  error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,

  -- Sourced identity.
  full_name TEXT DEFAULT '',
  title TEXT DEFAULT '',
  company TEXT DEFAULT '',
  domain TEXT DEFAULT '',
  linkedin_url TEXT DEFAULT '',
  location TEXT DEFAULT '',

  -- Why this lead is here at all. Without a citation an AI-sourced list is
  -- unauditable, and "the AI said so" is not a qualification a seller can act on.
  source TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  evidence TEXT DEFAULT '',

  -- Enriched values. `*_provider` is attribution for the cell: which vendor in
  -- the waterfall actually produced it.
  email TEXT DEFAULT '',
  email_verified INTEGER NOT NULL DEFAULT 0,
  email_provider TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  phone_verified INTEGER NOT NULL DEFAULT 0,
  phone_provider TEXT DEFAULT '',

  enrich_status TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_run ON leads(run_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(enrich_status);

-- Read-through cache so the same person is never bought twice. This is the
-- structural cost advantage over per-lead-priced SaaS, which has no incentive
-- to offer it.
--
-- Entries EXPIRE (see CACHE_MAX_AGE_DAYS): contact data decays as people change
-- jobs, so an unbounded cache would serve confidently-"verified" dead addresses
-- and wreck the bounce rate this product is judged on. It also stops us holding
-- personal data indefinitely for no stated purpose.
CREATE TABLE IF NOT EXISTS enrichment_cache (
  -- Normalized `field|full name|domain` — see cacheKey() in providers/index.ts.
  cache_key TEXT PRIMARY KEY,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT NOT NULL,
  found_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Supports both the staleness check and the retention sweep.
CREATE INDEX IF NOT EXISTS idx_cache_found_at ON enrichment_cache(found_at);

-- Append-only cost ledger: one row per provider call (and per deliberate skip).
-- Answers "why did this lead resolve the way it did, and what did it cost?"
CREATE TABLE IF NOT EXISTS enrichment_attempts (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  field TEXT NOT NULL,
  outcome TEXT NOT NULL, -- hit|miss|ineligible|unconfigured|no_credits|error
  credits_used INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  detail TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attempts_lead ON enrichment_attempts(lead_id);
CREATE INDEX IF NOT EXISTS idx_attempts_run ON enrichment_attempts(run_id);

-- The user's waterfall order per field. Stored as a JSON array of provider ids
-- so reordering in the UI is one write, and unknown/removed ids degrade to
-- "skipped" rather than breaking the run.
CREATE TABLE IF NOT EXISTS waterfall_config (
  field TEXT PRIMARY KEY, -- email|phone
  provider_order TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Which agent sourcing runs are dispatched to. Only meaningful for an org
-- running more than one agent: with a single agent the platform resolves it and
-- this stays empty. Deliberately a singleton (CHECK id = 1) rather than a
-- general key/value table — there is exactly one such choice, and a generic
-- config bag invites unrelated state to accumulate in it.
CREATE TABLE IF NOT EXISTS agent_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);
