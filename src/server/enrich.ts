// Per-lead enrichment: both fields' waterfalls, in order, with the email fed
// forward into the phone lookup — and the pause/resume path for vendors that
// answer by callback.
//
// Lives outside index.ts because four routes share it: the batch job, the
// single-lead enrich, the vendor callback, and the timeout sweep. Each is a
// different way of arriving at "continue this lead from here", and having one
// implementation is what keeps a lead resumed by a callback indistinguishable
// from one that never paused.

import { enqueueJob, type QueueEnv } from "@clawnify/queue";
import type { ConnectionsEnv } from "@clawnify/connections";
import { get, query, run } from "./db.js";
import { d1Cache, d1CompanyStore, recordAttempts } from "./cache.js";
import { runCompanyWaterfall } from "./providers/company.js";
import { applyDeferredResult, providerById, runWaterfall } from "./providers/index.js";
import type { EnrichField, EnrichResult, LeadInput, PendingWaterfall, WaterfallResult } from "./providers/types.js";

/** Field order. Email first: most phone vendors key on a work email. */
export const FIELDS: EnrichField[] = ["email", "phone"];

/**
 * How long a paused lead waits for a vendor's callback before the waterfall
 * gives up on that vendor and moves on. Deliberately under the run staleness
 * window (15 minutes) so a run that is only waiting on callbacks is never
 * reported as stalled: the deferred vendors document delivery in minutes, not
 * tens of minutes, and a lead parked for longer is more likely a lost callback
 * than a slow one.
 */
export const CALLBACK_TIMEOUT_MINUTES = 10;

export type EnrichEnv = ConnectionsEnv & QueueEnv;

export interface PendingRow {
  id: string;
  lead_id: string;
  run_id: string | null;
  field: EnrichField;
  provider_id: string;
  request_id: string;
  position: number;
  total_credits: number;
  fallback_value: string;
  fallback_provider: string;
  expires_at: string;
}

export function leadInput(row: Record<string, unknown>): LeadInput {
  return {
    fullName: String(row.full_name || "") || undefined,
    domain: String(row.domain || "") || undefined,
    company: String(row.company || "") || undefined,
    linkedinUrl: String(row.linkedin_url || "") || undefined,
    // An email already on the row is an *input*, not just an output: most phone
    // vendors key off an email or a profile URL rather than name + domain.
    email: String(row.email || "") || undefined,
  };
}

export interface EnrichOptions {
  orders: Record<EnrichField, string[]>;
  /** Company waterfall order. Separate from `orders` because it is not per-field. */
  companyOrder: string[];
  /** Public origin of this deployment, for callback URLs. Null when unknown. */
  origin: string | null;
  refresh?: boolean;
}

export interface EnrichOutcome {
  /** `waiting` when a deferred vendor now holds the lead; `done` otherwise. */
  status: "done" | "waiting";
  /** Credits spent in this pass — read from the attempts, so a resume never double-counts the carried total. */
  credits: number;
  cached: boolean;
}

/**
 * Enrich one lead from the start (or from `fromField` on, when resuming after
 * a completed field). Writes each field to the row as soon as it resolves, so
 * the next field's waterfall reads the freshly resolved email as its input
 * even across a pause.
 */
export async function enrichLead(
  lead: Record<string, unknown>,
  env: EnrichEnv,
  opts: EnrichOptions,
  fromField: EnrichField = FIELDS[0],
): Promise<EnrichOutcome> {
  const outcome: EnrichOutcome = { status: "done", credits: 0, cached: false };
  const row = { ...lead };
  for (const field of FIELDS.slice(FIELDS.indexOf(fromField))) {
    const token = crypto.randomUUID();
    const res = await runWaterfall(field, leadInput(row), env, {
      order: opts.orders[field],
      cache: d1Cache,
      refresh: opts.refresh,
      callbackUrl: callbackUrl(opts.origin, token),
    });
    const step = await settleField(row, field, res, token, env, opts.origin);
    fold(outcome, step);
    if (step.status === "waiting") return outcome;
  }
  await finishLead(row, outcome, env, opts);
  return outcome;
}

/**
 * A deferred vendor answered (or the sweep gave up on it): fold the answer into
 * the paused field, then carry on through the remaining fields.
 *
 * Returns false when the token matches nothing — a late or duplicate callback,
 * which is ignored rather than treated as an error so a vendor that retries
 * deliveries cannot re-enrich a lead that already moved on.
 */
export async function resumeLead(token: string, answer: EnrichResult, env: EnrichEnv, opts: EnrichOptions): Promise<boolean> {
  const pending = await get<PendingRow>("SELECT * FROM pending_enrichments WHERE id = ?", [token]);
  if (!pending) return false;
  await run("DELETE FROM pending_enrichments WHERE id = ?", [token]);

  const lead = await get<Record<string, unknown>>("SELECT * FROM leads WHERE id = ?", [pending.lead_id]);
  if (!lead) return true;
  // Heartbeat: a run that is only waiting on callbacks otherwise goes quiet
  // from the last batch until the last answer, and would read as stalled if a
  // timeout sweep is delivered late.
  if (pending.run_id) await run("UPDATE runs SET updated_at = datetime('now') WHERE id = ? AND status = 'enriching'", [pending.run_id]);
  const row = { ...lead };
  const paused: PendingWaterfall = {
    providerId: pending.provider_id,
    requestId: pending.request_id,
    position: pending.position,
    totalCredits: pending.total_credits,
    fallback: pending.fallback_value ? { value: pending.fallback_value, providerId: pending.fallback_provider } : null,
  };

  const nextToken = crypto.randomUUID();
  const res = await applyDeferredResult(pending.field, leadInput(row), env, paused, answer, {
    order: opts.orders[pending.field],
    cache: d1Cache,
    callbackUrl: callbackUrl(opts.origin, nextToken),
  });
  const outcome: EnrichOutcome = { status: "done", credits: 0, cached: false };
  const step = await settleField(row, pending.field, res, nextToken, env, opts.origin);
  fold(outcome, step);
  if (step.status === "waiting") return true;

  const next = FIELDS[FIELDS.indexOf(pending.field) + 1];
  if (next) {
    // enrichLead finishes the lead itself; only the last field falls through.
    await enrichLead(row, env, opts, next);
  } else {
    await finishLead(row, outcome, env, opts);
  }
  return true;
}

/**
 * Give up on every pause whose callback is overdue. Each becomes an `error`
 * attempt naming the vendor, and the lead resumes from the next provider.
 * Run by the sweep job per token, and by the batch job per run as a backstop
 * for a deployment whose queue could not schedule the sweep.
 */
export async function expireOverdue(env: EnrichEnv, opts: EnrichOptions, scope: { token?: string; runId?: string }): Promise<number> {
  const where = scope.token ? "id = ?" : "run_id = ?";
  const rows = await query<PendingRow>(
    `SELECT * FROM pending_enrichments WHERE ${where} AND expires_at <= datetime('now') LIMIT 50`,
    [scope.token ?? scope.runId ?? ""],
  );
  for (const p of rows) {
    const label = providerById(p.provider_id)?.label ?? p.provider_id;
    await resumeLead(
      p.id,
      {
        outcome: "error",
        value: null,
        verified: false,
        creditsUsed: 0,
        detail: `No callback from ${label} within ${CALLBACK_TIMEOUT_MINUTES} minutes (request ${p.request_id || "unknown"})`,
      },
      env,
      opts,
    );
  }
  return rows.length;
}

/** Drop a lead's pauses before re-running it, so a late callback cannot overwrite the new pass. */
export async function cancelPending(leadId: string): Promise<void> {
  await run("DELETE FROM pending_enrichments WHERE lead_id = ?", [leadId]);
}

/**
 * Mark a run done once nothing in it is still moving. Called after every
 * out-of-band completion; the batch job checks the same condition itself. The
 * status guard keeps a callback for a lead re-enriched by hand from touching a
 * run that already finished.
 */
export async function finishRunIfDrained(runId: string | null): Promise<void> {
  if (!runId) return;
  await run(
    `UPDATE runs SET status = 'done', updated_at = datetime('now')
      WHERE id = ? AND status = 'enriching'
        AND NOT EXISTS (SELECT 1 FROM leads WHERE run_id = ? AND enrich_status IN ('pending', 'running', 'waiting'))`,
    [runId, runId],
  );
}

// ── internals ───────────────────────────────────────────────────────

function callbackUrl(origin: string | null, token: string): string | undefined {
  return origin ? `${origin}/api/callbacks/${token}` : undefined;
}

function fold(into: EnrichOutcome, step: EnrichOutcome): void {
  into.credits += step.credits;
  into.cached ||= step.cached;
  into.status = step.status;
}

/**
 * Record one field's waterfall result: the attempts to the ledger, a resolved
 * value to the row, or a pause to pending_enrichments with its timeout sweep.
 */
async function settleField(
  row: Record<string, unknown>,
  field: EnrichField,
  res: WaterfallResult,
  token: string,
  env: EnrichEnv,
  origin: string | null,
): Promise<EnrichOutcome> {
  const leadId = String(row.id);
  const runId = row.run_id ? String(row.run_id) : null;
  await recordAttempts(leadId, runId, res.attempts);
  const credits = res.attempts.reduce((n, a) => n + a.creditsUsed, 0);

  if (res.pending) {
    const p = res.pending;
    // Row first, status second: a callback that lands between the two finds
    // its row and resumes; the status write below is then a no-op because the
    // lead is no longer `running`.
    await run(
      `INSERT INTO pending_enrichments (id, lead_id, run_id, field, provider_id, request_id, position, total_credits, fallback_value, fallback_provider, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`,
      [token, leadId, runId, field, p.providerId, p.requestId, p.position, p.totalCredits, p.fallback?.value ?? "", p.fallback?.providerId ?? "", `+${CALLBACK_TIMEOUT_MINUTES} minutes`],
    );
    await run("UPDATE leads SET enrich_status = 'waiting', updated_at = datetime('now') WHERE id = ? AND enrich_status = 'running'", [leadId]);
    await scheduleSweep(env, origin, token);
    return { status: "waiting", credits, cached: false };
  }

  if (res.value) {
    await run(`UPDATE leads SET ${field} = ?, ${field}_verified = ?, ${field}_provider = ?, updated_at = datetime('now') WHERE id = ?`, [
      res.value,
      res.verified ? 1 : 0,
      res.providerId ?? "",
      leadId,
    ]);
    row[field] = res.value;
  }
  return { status: "done", credits, cached: res.cached };
}

async function finishLead(
  row: Record<string, unknown>,
  outcome: EnrichOutcome,
  env: EnrichEnv,
  opts: EnrichOptions,
): Promise<void> {
  await enrichCompany(row, outcome, env, opts);
  await run("UPDATE leads SET enrich_status = 'done', updated_at = datetime('now') WHERE id = ?", [String(row.id)]);
  outcome.status = "done";
  await finishRunIfDrained(row.run_id ? String(row.run_id) : null);
}

/**
 * Resolve the lead's employer, once the person themselves is settled.
 *
 * Hung off finishLead rather than the field loop because that is the one place
 * a lead is *actually* done — reached both by a straight run and by a resume
 * after a callback — so a paused lead's company is enriched exactly once, when
 * it lands, rather than on every pass through the loop.
 *
 * Per lead rather than per distinct domain, which is safe because the batch job
 * enriches leads sequentially and the store write lands before the next lead
 * starts: the second lead at the same company reads the row instead of buying
 * it again. The attempt log records the company row against the lead that paid
 * for it, so the run's credit total stays the sum of one ledger.
 */
async function enrichCompany(
  row: Record<string, unknown>,
  outcome: EnrichOutcome,
  env: EnrichEnv,
  opts: EnrichOptions,
): Promise<void> {
  if (opts.companyOrder.length === 0) return;
  const res = await runCompanyWaterfall(String(row.domain || ""), env, {
    order: opts.companyOrder,
    store: d1CompanyStore,
    refresh: opts.refresh,
  });
  if (res.attempts.length === 0) return;
  await recordAttempts(String(row.id), row.run_id ? String(row.run_id) : null, res.attempts);
  outcome.credits += res.attempts.reduce((n, a) => n + a.creditsUsed, 0);
}

/**
 * The timeout for one pause, as a delayed queue delivery. Best effort: without
 * a queue (local dev) the batch job's per-run backstop and the next manual
 * enrich still expire it, just not on a clock.
 */
async function scheduleSweep(env: EnrichEnv, origin: string | null, token: string): Promise<void> {
  if (!origin || !env.CLAWNIFY_TOKEN) return;
  try {
    await enqueueJob(env, {
      targetUrl: `${origin}/api/jobs/sweep-pending`,
      payload: { token },
      runAt: new Date(Date.now() + CALLBACK_TIMEOUT_MINUTES * 60_000),
      idempotencyKey: `sweep:${token}`,
      maxAttempts: 3,
    });
  } catch {
    // The backstops above cover a queue that is down; failing the lead over a
    // missing timer would be the wrong trade.
  }
}
