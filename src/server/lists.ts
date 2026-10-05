// Lists: people that keep arriving from searches and signals, for campaigns to
// read. This file is the behaviour; list-routes.ts is the HTTP surface.
//
// Three things happen to a list on their own, all through the platform queue:
//
// 1. People join. Leads posted to a search join the lists that search feeds
//    (and so do the leads of every re-run of it); a person a signal finds joins
//    the lists that signal feeds. A person is in a list once.
// 2. Its searches run again on its cadence (hourly, daily, weekly), each as a
//    new run handed to the agent the same way the original was. Signals keep
//    the schedule they were created with.
// 3. New people without an email are looked up, emails only, at most the
//    list's daily cap per UTC day. With no cap set the cap is what the
//    campaigns reading the list take a day, so lookups follow demand.

import { enqueueJob } from "@clawnify/queue";
import { get, query, run } from "./db.js";
import { dispatchRun, RUN_SELECT, STALE_AFTER } from "./runs.js";
import type { AgentEnv } from "./agent.js";

export const REFRESH = ["hourly", "daily", "weekly", "off"] as const;
export type Refresh = (typeof REFRESH)[number];

const INTERVAL_MS: Record<Exclude<Refresh, "off">, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** Rows per bulk insert: 50 ids plus the list's own few, under D1's 100 bound parameters. */
const CHUNK = 50;

export type ListsEnv = AgentEnv & { CLAWNIFY_QUEUE_URL?: string };

export interface ListRow {
  id: string;
  name: string;
  refresh: Refresh;
  email_daily_cap: number | null;
  lookups_day: string | null;
  lookups_used: number;
  last_refreshed_at: string | null;
  next_refresh_at: string | null;
  created_at: string;
  updated_at: string;
}

/** When a list's searches run next: one interval after `from`, or never. */
export function nextRefresh(refresh: string, from: Date): string | null {
  const ms = INTERVAL_MS[refresh as Exclude<Refresh, "off">];
  return ms ? new Date(from.getTime() + ms).toISOString() : null;
}

/** The UTC day a lookup counts against. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Just after the next UTC midnight, when a used-up day's lookups are free again. */
export function nextUtcDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(24, 1, 0, 0);
  return d;
}

/**
 * How many automatic lookups a list may start per UTC day, and where that
 * number comes from: the list's own cap; else what the campaigns reading it
 * take a day; else none, so nothing is bought until someone says how much.
 */
export async function effectiveCap(listId: string): Promise<{ cap: number; from: "list" | "consumers" | "none" }> {
  const list = await get<{ email_daily_cap: number | null }>("SELECT email_daily_cap FROM lists WHERE id = ?", [listId]);
  if (!list) return { cap: 0, from: "none" };
  if (list.email_daily_cap !== null) return { cap: list.email_daily_cap, from: "list" };
  const sum = await get<{ n: number | null }>("SELECT SUM(daily) AS n FROM list_consumers WHERE list_id = ?", [listId]);
  const n = sum?.n ?? 0;
  return n > 0 ? { cap: n, from: "consumers" } : { cap: 0, from: "none" };
}

/** Lookups already started today: the counter only counts for its own day. */
export function lookupsToday(list: Pick<ListRow, "lookups_day" | "lookups_used">, now: Date): number {
  return list.lookups_day === utcDay(now) ? list.lookups_used : 0;
}

// ── Membership ──────────────────────────────────────────────────────

interface Identity {
  id: string;
  linkedin_url: string | null;
  full_name: string | null;
  domain: string | null;
}

/** The same person, whichever lead row they arrived on: one profile, or one name at one domain. */
function identityKeys(l: Identity): string[] {
  const keys: string[] = [];
  const profile = (l.linkedin_url || "").trim().toLowerCase();
  if (profile) keys.push(`p:${profile}`);
  const name = (l.full_name || "").trim().toLowerCase();
  const domain = (l.domain || "").trim().toLowerCase();
  if (name && domain) keys.push(`n:${name}|${domain}`);
  return keys;
}

/**
 * Adds leads to a list, once per person. A lead already in it is skipped, and
 * so is a second lead for someone already in it: a search re-run that finds
 * the same people again adds nobody. Returns how many joined.
 */
export async function addMembers(listId: string, leadIds: string[], kind: "search" | "signal" | "manual", sourceId: string): Promise<number> {
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return 0;
  let added = 0;
  // Repeats inside this one batch, which the NOT EXISTS below cannot see.
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const leads = await query<Identity>(
      `SELECT id, linkedin_url, full_name, domain FROM leads WHERE id IN (${chunk.map(() => "?").join(", ")})`,
      chunk,
    );
    const fresh = leads.filter((l) => {
      const keys = identityKeys(l);
      if (keys.some((k) => seen.has(k))) return false;
      keys.forEach((k) => seen.add(k));
      return true;
    });
    if (fresh.length === 0) continue;
    // One statement per chunk: an import of 500 into a search feeding two
    // lists must stay well inside D1's queries per request. The NOT EXISTS
    // sees only people already in the list; repeats inside this batch were
    // dropped above.
    const res = await run(
      `INSERT INTO list_members (list_id, lead_id, added_at, source_kind, source_id)
       SELECT ?, l.id, ?, ?, ? FROM leads l
        WHERE l.id IN (${fresh.map(() => "?").join(", ")})
          AND NOT EXISTS (
            SELECT 1 FROM list_members m JOIN leads o ON o.id = m.lead_id
             WHERE m.list_id = ? AND (
               (l.linkedin_url != '' AND lower(o.linkedin_url) = lower(l.linkedin_url))
               OR (l.full_name != '' AND l.domain != '' AND lower(o.full_name) = lower(l.full_name) AND lower(o.domain) = lower(l.domain))
             ))
       ON CONFLICT (list_id, lead_id) DO NOTHING`,
      [listId, new Date().toISOString(), kind, sourceId, ...fresh.map((l) => l.id), listId],
    );
    added += res.changes;
  }
  if (added > 0) await run("UPDATE lists SET updated_at = datetime('now') WHERE id = ?", [listId]);
  return added;
}

/** The lists a source feeds. */
export async function listsFedBy(kind: "search" | "signal", sourceId: string): Promise<string[]> {
  const rows = await query<{ list_id: string }>("SELECT list_id FROM list_sources WHERE kind = ? AND source_id = ?", [kind, sourceId]);
  return rows.map((r) => r.list_id);
}

/** The search a run belongs to: itself, or the search it re-ran for a list. */
export async function searchOf(runId: string): Promise<string | null> {
  const row = await get<{ id: string; refresh_of: string | null }>("SELECT id, refresh_of FROM runs WHERE id = ?", [runId]);
  return row ? row.refresh_of || row.id : null;
}

/** Leads posted to a run join the lists its search feeds. Returns the lists that grew. */
export async function joinFromRun(runId: string, leadIds: string[]): Promise<string[]> {
  const search = await searchOf(runId);
  if (!search || leadIds.length === 0) return [];
  const grew: string[] = [];
  for (const listId of await listsFedBy("search", search)) {
    if ((await addMembers(listId, leadIds, "search", search)) > 0) grew.push(listId);
  }
  return grew;
}

/** A person a signal found joins the lists that signal feeds. Returns the lists that grew. */
export async function joinFromSignal(monitorId: string, leadId: string): Promise<string[]> {
  const grew: string[] = [];
  for (const listId of await listsFedBy("signal", monitorId)) {
    if ((await addMembers(listId, [leadId], "signal", monitorId)) > 0) grew.push(listId);
  }
  return grew;
}

/**
 * The people a source already has, added when it is attached: every lead of
 * the search and its re-runs, or everyone a person already added to People
 * from the signal. Findings nobody reviewed before the signal was attached
 * stay where they are; from now on, its new ones join without review.
 */
export async function backfill(listId: string, kind: "search" | "signal", sourceId: string): Promise<number> {
  const rows =
    kind === "search"
      ? await query<{ id: string }>(
          "SELECT id FROM leads WHERE run_id IN (SELECT id FROM runs WHERE id = ? OR refresh_of = ?) ORDER BY created_at, id",
          [sourceId, sourceId],
        )
      : await query<{ id: string }>(
          "SELECT lead_id AS id FROM signal_observations WHERE monitor_id = ? AND visible = 1 AND lead_id IS NOT NULL ORDER BY observed_at, id",
          [sourceId],
        );
  return addMembers(listId, rows.map((r) => r.id), kind, sourceId);
}

// ── Email lookups ───────────────────────────────────────────────────

async function giveBack(listId: string, day: string): Promise<void> {
  await run("UPDATE lists SET lookups_used = lookups_used - 1 WHERE id = ? AND lookups_day = ? AND lookups_used > 0", [listId, day]);
}

/**
 * Starts automatic email lookups for a list's new people, at most its daily
 * cap per UTC day. Emails only, from the cache when it has them, and never for
 * someone already looked up: only a lead that was never enriched qualifies.
 *
 * Each lookup takes a slot first, in one statement that refuses past the cap,
 * so two passes at once cannot go over it. A lead claimed elsewhere in the
 * meantime gives its slot back. Returns how many started.
 */
export async function lookUpEmails(env: ListsEnv, origin: string, listId: string, now = new Date()): Promise<number> {
  const { cap } = await effectiveCap(listId);
  if (cap <= 0) return 0;
  const day = utcDay(now);
  const batch = Math.min(cap, 100);
  const waiting = await query<{ id: string }>(
    `SELECT l.id FROM list_members m JOIN leads l ON l.id = m.lead_id
      WHERE m.list_id = ? AND l.email = '' AND l.enrich_status = 'pending'
      ORDER BY m.added_at, m.lead_id LIMIT ?`,
    [listId, batch],
  );
  let started = 0;
  for (const { id } of waiting) {
    const slot = await run(
      `UPDATE lists
          SET lookups_used = (CASE WHEN lookups_day = ? THEN lookups_used ELSE 0 END) + 1, lookups_day = ?
        WHERE id = ? AND (CASE WHEN lookups_day = ? THEN lookups_used ELSE 0 END) < ?`,
      [day, day, listId, day, cap],
    );
    if (slot.changes === 0) break;
    // Emails only: set on the lead, so a resume after a vendor callback cannot
    // go on to buy a phone (enrich.ts, leadFields).
    const claim = await run(
      `UPDATE leads SET enrich_status = 'running', enrich_fields = 'email', updated_at = datetime('now')
        WHERE id = ? AND enrich_status = 'pending' AND email = ''`,
      [id],
    );
    if (claim.changes === 0) {
      await giveBack(listId, day);
      continue;
    }
    try {
      await enqueueJob(env, {
        targetUrl: `${origin}/api/jobs/enrich-lead`,
        payload: { leadId: id, refresh: false },
        maxAttempts: 3,
      });
      started++;
    } catch {
      // shortcut: no queue means local development (no platform token). The
      // lead and its slot go back, and automatic lookups wait for the platform.
      await run("UPDATE leads SET enrich_status = 'pending', enrich_fields = NULL WHERE id = ? AND enrich_status = 'running'", [id]);
      await giveBack(listId, day);
      return started;
    }
  }
  // People still waiting? With today's lookups used up, look again just after
  // midnight UTC, whatever the list's refresh cadence. With some left (a cap
  // above one batch), carry on with the next slice now.
  const left = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM list_members m JOIN leads l ON l.id = m.lead_id
      WHERE m.list_id = ? AND l.email = '' AND l.enrich_status = 'pending'`,
    [listId],
  );
  if ((left?.n ?? 0) > 0) {
    const used = await get<Pick<ListRow, "lookups_day" | "lookups_used">>("SELECT lookups_day, lookups_used FROM lists WHERE id = ?", [listId]);
    if (used && lookupsToday(used, now) >= cap) await bookTick(env, origin, listId, nextUtcDay(now));
    else if (started > 0) await bookTick(env, origin, listId, now);
  }
  return started;
}

/**
 * After people joined lists: start their lookups. Best effort, never the
 * reason the write that added them fails; a list's next tick catches up.
 */
export async function afterJoin(env: ListsEnv, origin: string, listIds: string[]): Promise<void> {
  for (const listId of listIds) {
    try {
      await lookUpEmails(env, origin, listId);
    } catch (e) {
      console.error(`List ${listId}: lookups after new people failed`, e);
    }
  }
}

// ── Refresh ─────────────────────────────────────────────────────────

/** A search's latest re-run, with the state the list shows for it. */
export interface RefreshRun {
  id: string;
  status: string;
  error: string;
  lead_count: number;
  created_at: string;
  updated_at: string;
  stale: number;
}

export async function latestRefresh(searchId: string): Promise<RefreshRun | null> {
  return (
    (await get<RefreshRun>(
      `SELECT ${RUN_SELECT} FROM runs WHERE refresh_of = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [STALE_AFTER, searchId],
    )) ?? null
  );
}

/**
 * Why a search is not re-run on schedule, or null when it can be. A re-run
 * still working is left alone; one that failed, stalled or never reached the
 * agent holds the search until a person looks (Refresh now), because a broken
 * agent taking a fresh task every hour costs money and fixes nothing.
 */
export function refreshHold(last: RefreshRun | null): "working" | "failed" | "stalled" | "undelivered" | null {
  if (!last) return null;
  if (last.stale) return "stalled";
  if (last.status === "failed") return "failed";
  if (last.status === "pending" && last.error) return "undelivered";
  if (["pending", "sourcing", "enriching"].includes(last.status)) return "working";
  return null;
}

/**
 * Runs a list's searches again: a new run per search, with the same
 * description, handed to the agent the way the original was. On schedule the
 * list is claimed first (the due time moves in the same statement), so two
 * ticks at once refresh it once. `force` is Refresh now: it also retries a
 * search held by a failed or stalled re-run.
 *
 * Re-runs never start enrichment themselves: the list's capped lookups buy the
 * emails, so a search set to include emails cannot spend past the cap.
 */
export async function refreshList(
  env: ListsEnv,
  origin: string,
  listId: string,
  now = new Date(),
  force = false,
): Promise<{ claimed: boolean; started: number; failed: number }> {
  const list = await get<ListRow>("SELECT * FROM lists WHERE id = ?", [listId]);
  if (!list) return { claimed: false, started: 0, failed: 0 };
  const at = now.toISOString();
  const next = nextRefresh(list.refresh, now);
  const claim = force
    ? await run("UPDATE lists SET last_refreshed_at = ?, next_refresh_at = ?, updated_at = datetime('now') WHERE id = ?", [at, next, listId])
    : await run(
        `UPDATE lists SET last_refreshed_at = ?, next_refresh_at = ?, updated_at = datetime('now')
          WHERE id = ? AND refresh != 'off' AND next_refresh_at IS NOT NULL AND next_refresh_at <= ?`,
        [at, next, listId, at],
      );
  if (claim.changes === 0) return { claimed: false, started: 0, failed: 0 };

  let started = 0;
  let failed = 0;
  const searches = await query<{ source_id: string }>(
    "SELECT source_id FROM list_sources WHERE list_id = ? AND kind = 'search' ORDER BY added_at, source_id",
    [listId],
  );
  for (const { source_id } of searches) {
    // The original search may itself still be working.
    const original = await get<{ status: string; stale: number }>(`SELECT ${RUN_SELECT} FROM runs WHERE id = ?`, [STALE_AFTER, source_id]);
    if (!original) continue;
    if (["sourcing", "enriching"].includes(original.status) && !original.stale) continue;
    const hold = refreshHold(await latestRefresh(source_id));
    if (hold === "working" || (hold && !force)) continue;
    const id = crypto.randomUUID();
    await run(
      `INSERT INTO runs (id, icp_prompt, status, source, enrich_fields, auto_enrich, refresh_of)
       SELECT ?, icp_prompt, 'pending', source, enrich_fields, 0, id FROM runs WHERE id = ?`,
      [id, source_id],
    );
    // A failed handoff stays on the run row (its error), and the list shows it.
    if ((await dispatchRun(env, origin, id)).ok) started++;
    else failed++;
  }
  if (next) await bookTick(env, origin, listId, new Date(next));
  return { claimed: true, started, failed };
}

// ── The tick ────────────────────────────────────────────────────────

/**
 * Books a list's next tick on the platform queue. The key is the list and the
 * minute, so booking the same moment twice books it once. No queue (local
 * development) is not an error: the list simply refreshes on Refresh now.
 */
export async function bookTick(env: ListsEnv, origin: string, listId: string, when: Date): Promise<boolean> {
  try {
    await enqueueJob(env, {
      targetUrl: `${origin}/api/jobs/list-tick`,
      payload: { listId },
      runAt: when,
      idempotencyKey: `list-tick:${listId}:${when.toISOString().slice(0, 16)}`,
      maxAttempts: 3,
    });
    return true;
  } catch {
    return false;
  }
}

/** One tick: refresh when it is due, then look up what the cap allows. */
export async function tick(env: ListsEnv, origin: string, listId: string, now = new Date()): Promise<{ refreshed: boolean; lookups: number }> {
  const list = await get<ListRow>("SELECT * FROM lists WHERE id = ?", [listId]);
  if (!list) return { refreshed: false, lookups: 0 };
  let refreshed = false;
  if (list.next_refresh_at && Date.parse(list.next_refresh_at) <= now.getTime()) {
    refreshed = (await refreshList(env, origin, listId, now)).claimed;
  }
  const lookups = await lookUpEmails(env, origin, listId, now);
  return { refreshed, lookups };
}
