// Handing a run to the agent, shared by the dispatch route and by a list's
// refresh, which starts a search again on its own schedule.

import { get, query, run } from "./db.js";
import { companyBatches, companyBrief, dispatchTask, sourcingBrief, type AgentEnv, type AgentServer } from "./agent.js";
import { salesNavigatorBrief } from "./sales-navigator.js";

/**
 * How long a run may sit in `sourcing` without an update before the UI calls it
 * stalled. Agent turns are legitimately slow (minutes), so this is generous;
 * it exists to catch an agent that died mid-task, which is the one failure the
 * app cannot otherwise distinguish from "still working".
 */
export const STALE_AFTER = "-15 minutes";

/**
 * A lead left `running` this long was mid-vendor-call when its delivery died
 * (the consumer's wall clock, a crash) and will never be picked up by a chain
 * that only selects `pending`. Reclaimed on the next delivery; the cache makes
 * a repeat of its already-verified fields free.
 */
export const STRANDED_AFTER = "-15 minutes";

/**
 * Every runs read goes through this so `stale` can never drift between routes.
 *
 * Covers `enriching` as well as `sourcing`: a queued enrichment that never got
 * delivered leaves the run mid-flight with nothing to report the failure, which
 * looked identical to one still working. Both in-flight states now have a clock.
 * The enrich job heartbeats `updated_at` per batch so a long, healthy run is
 * never mistaken for a dead one.
 */
export const RUN_SELECT =
  `*, (CASE WHEN status IN ('sourcing', 'enriching') AND updated_at < datetime('now', ?) THEN 1 ELSE 0 END) AS stale`;

/** The chosen agent, or null to let the platform resolve a single-agent org. */
export async function configuredServerId(): Promise<string | null> {
  const row = await get<{ server_id: string }>("SELECT server_id FROM agent_config WHERE id = 1");
  return row?.server_id || null;
}

interface DispatchableRun {
  id: string;
  icp_prompt: string;
  status: string;
  source: string;
  auto_enrich: number;
  company_domain: string | null;
  updated_at: string;
  stale: number;
}

export type RunDispatch =
  | { ok: true; taskId: string; serverId: string | null; duplicate: boolean }
  | { ok: false; status: 404 | 409 | 502; error: string; brief?: string; servers?: AgentServer[] };

/**
 * Hand a run to the agent.
 *
 * Kept separate from run creation deliberately: the run is a durable record the
 * moment the user describes an ICP, and a dispatch failure must not erase it.
 * The same call then serves as the retry for a run whose agent died mid-task.
 */
export async function dispatchRun(env: AgentEnv, appUrl: string, runId: string): Promise<RunDispatch> {
  const row = await get<DispatchableRun>(`SELECT ${RUN_SELECT} FROM runs WHERE id = ?`, [STALE_AFTER, runId]);
  if (!row) return { ok: false, status: 404, error: "Run not found" };

  // Refuse to dispatch work already in flight. A *stalled* sourcing run falls
  // through on purpose: that is exactly the case worth retrying.
  if ((row.status === "sourcing" && !row.stale) || row.status === "enriching") {
    return { ok: false, status: 409, error: "This search is already running." };
  }
  if (row.status === "done") return { ok: false, status: 409, error: "This search has already finished." };

  const brief = row.company_domain
    ? companyBrief(appUrl, [{ id: runId, company_domain: row.company_domain }])
    : row.source === "sales_navigator"
      ? salesNavigatorBrief({ runId, url: row.icp_prompt, appUrl, includeEmails: row.auto_enrich === 1 })
      : sourcingBrief({ runId, prompt: row.icp_prompt, appUrl });

  // Idempotency key = run id + the row's current updated_at. A double-click
  // carries the same key (nothing has changed yet) so the platform delivers
  // once; a genuine retry later carries a different one, because a successful
  // dispatch bumps updated_at. Keying on the run id alone would look safer and
  // silently swallow every retry for 24 hours, the worse failure.
  const result = await dispatchTask(env, {
    instruction: brief,
    serverId: await configuredServerId(),
    idempotencyKey: `${runId}:${row.updated_at}`,
  });

  if (!result.ok) {
    // updated_at is deliberately NOT bumped here: nothing was delivered, so a
    // failed retry must not reset the staleness clock on the original attempt.
    // The platform records its idempotency key only after a successful
    // dispatch, so retrying with the unchanged key still goes through.
    await run("UPDATE runs SET error = ? WHERE id = ?", [result.error.slice(0, 2000), runId]);
    return { ok: false, status: 502, error: result.error, brief, servers: result.servers ?? [] };
  }

  // A search retried on its own leaves any batch it was handed over in.
  await run("UPDATE runs SET status = 'sourcing', error = '', dispatch_batch = NULL, updated_at = datetime('now') WHERE id = ?", [runId]);
  return { ok: true, taskId: result.taskId, serverId: result.serverId, duplicate: result.duplicate };
}

/**
 * Hand new company searches to the agent, as few tasks as the instruction cap
 * allows. Only searches still `pending` go. A batch the agent refuses keeps its
 * searches pending with the reason, and each can be retried on its own with
 * dispatchRun.
 */
export async function dispatchCompanySearches(env: AgentEnv, appUrl: string, runIds: string[]): Promise<{ started: number; failed: number }> {
  const searches: { id: string; company_domain: string }[] = [];
  // Chunked: D1 binds at most 100 parameters per statement.
  for (let i = 0; i < runIds.length; i += 90) {
    const chunk = runIds.slice(i, i + 90);
    searches.push(...(await query<{ id: string; company_domain: string }>(
      `SELECT id, company_domain FROM runs
        WHERE id IN (${chunk.map(() => "?").join(", ")}) AND status = 'pending' AND company_domain IS NOT NULL
        ORDER BY created_at, id`,
      chunk,
    )));
  }
  const serverId = await configuredServerId();
  let started = 0;
  let failed = 0;
  for (const batch of companyBatches(appUrl, searches)) {
    const ids = batch.searches.map((s) => s.id);
    const marks = ids.map(() => "?").join(", ");
    // New searches only ever reach here once, so the batch's first search
    // and its size key it: a repeat of this same call is delivered once.
    const key = `company-searches:${ids[0]}:${ids.length}`;
    const result = await dispatchTask(env, { instruction: batch.brief, serverId, idempotencyKey: key });
    if (result.ok) {
      await run(
        `UPDATE runs SET status = 'sourcing', error = '', dispatch_batch = ?, updated_at = datetime('now') WHERE id IN (${marks}) AND status = 'pending'`,
        [key, ...ids],
      );
      started += ids.length;
    } else {
      await run(`UPDATE runs SET error = ? WHERE id IN (${marks})`, [result.error.slice(0, 2000), ...ids]);
      failed += ids.length;
    }
  }
  return { started, failed };
}

/**
 * The agent reported on a run: the other searches handed over in the same task
 * and not finished yet share the heartbeat (runs.dispatch_batch).
 */
export async function touchBatch(runId: string): Promise<void> {
  await run(
    `UPDATE runs SET updated_at = datetime('now')
      WHERE dispatch_batch = (SELECT dispatch_batch FROM runs WHERE id = ?) AND status = 'sourcing' AND id != ?`,
    [runId, runId],
  );
}
