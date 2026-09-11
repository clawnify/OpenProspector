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

  enrich_status TEXT NOT NULL DEFAULT 'pending', -- pending|running|waiting|done|failed
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

-- A waterfall paused at a vendor that answers by callback. One row per pause;
-- the id is the callback token, so a POST to /api/callbacks/<provider>/<id>
-- resolves straight back to the lead, the field, and where to resume. Deleted
-- when the answer lands or the timeout sweep gives up on it — a late callback
-- that finds no row is simply ignored.
CREATE TABLE IF NOT EXISTS pending_enrichments (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  run_id TEXT,
  field TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  request_id TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  total_credits INTEGER NOT NULL DEFAULT 0,
  fallback_value TEXT NOT NULL DEFAULT '',
  fallback_provider TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_lead ON pending_enrichments(lead_id);
CREATE INDEX IF NOT EXISTS idx_pending_run ON pending_enrichments(run_id);

-- A dated, public reason to talk to a company now. Not a lead: there is no
-- person here, and the subject is the account.
--
-- This table exists for two things a stateless sweep cannot do. Re-running a
-- sweep must not open a second run for an item already seen, because a run
-- spends enrichment credits. And a job post that keeps reappearing is a role
-- nobody can fill, which is a better reason to call than the first sighting
-- was — so a repeat sighting bumps `seen_count` instead of being discarded.
--
-- The CRM is a destination for what survives the rules, never the store: an
-- org keeping its own CRM elsewhere still needs somewhere to dedupe, and
-- writing every raw sighting to someone's CRM timeline is not that place.
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  -- Bare registrable host (see normalizeDomain). The join key to leads.domain
  -- and to whatever the org calls an account.
  domain TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  -- hiring|funding|site_change|stack|review, or anything else: an unknown type
  -- gets the short fallback window rather than being refused, so a new source
  -- does not need a schema change.
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  -- No URL, no signal. A claim about a prospect that cannot be shown to them
  -- is not usable by the person who has to make the call.
  source_url TEXT NOT NULL,
  -- When the event HAPPENED. Distinct from detected_at on purpose: job boards
  -- bump and repost, so the date a listing surfaced is not the date the role
  -- opened, and every freshness decision is made against this column.
  occurred_at TEXT NOT NULL,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- How many sweeps have seen this same item, and when we last did.
  seen_count INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- new: waiting on a person. queued: a run was opened for it.
  -- dismissed: a person said no, and said why. suppressed: the account was
  -- already in play, so it is kept as evidence but never routed.
  status TEXT NOT NULL DEFAULT 'new',
  dismiss_reason TEXT NOT NULL DEFAULT '',
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  -- normalizeDomain|type|normalizeUrl. The uniqueness rule, and the reason a
  -- re-sweep is free.
  dedupe_key TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_signals_domain ON signals(domain);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_occurred ON signals(occurred_at);
