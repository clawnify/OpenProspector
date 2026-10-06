import { createApp, createRoute, z } from "@clawnify/app";
import { createAgents, ClawnifyAgentsError, type AgentsEnv } from "@clawnify/agents";
import { get, query, run } from "./db.js";
import { MonitorEdit, MonitorInput, SignalObservationInput, linkedinUrl, type Monitor, type MonitorConfig, type Observation } from "../shared/monitors.js";
import { normalizeDomain, normalizeUrl } from "./signals.js";
import { signalBrief } from "./signal-brief.js";
import { afterJoin, joinFromSignal, listsFedBy } from "./lists.js";
import { STALE_AFTER } from "./runs.js";
import { companyOf, searchCompanies, type Company } from "./company-search.js";

type Env = { Bindings: AgentsEnv };
interface MonitorRow { id: string; config: string; create_request: string; active: number; schedule_id: string | null; schedule_error: string | null; created_at: string }
interface Check { id: string; monitor_id: string; status: string; baseline: number; error: string; coverage: string; created_at: string; updated_at: string }
interface ObservationRow { id: string; monitor_id: string; details: string; observed_at: string; lead_id: string | null }
class InputError extends Error { constructor(message: string, readonly status: 400 | 404 | 409 | 410 = 400) { super(message); } }
const UUID = z.string().uuid();
const Page = z.coerce.number().int().min(1).max(40000).default(1);
const LIMIT = 25;
const INTERVAL = { daily: 86400000, weekly: 604800000 };

async function readMonitor(id: string) {
  const row = await get<MonitorRow>("SELECT * FROM signal_monitors WHERE id = ?", [UUID.parse(id)]);
  if (!row) throw new InputError("Monitor not found", 404);
  return row;
}
function config(row: MonitorRow): MonitorConfig { return MonitorInput.parse(JSON.parse(row.config)); }
async function present(row: MonitorRow): Promise<Monitor> {
  const last_check = await get<Check>("SELECT * FROM signal_checks WHERE monitor_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [row.id]);
  const { config: _, create_request: __, ...rest } = row;
  return { ...rest, ...config(row), active: Boolean(row.active), last_check: last_check ?? null };
}
async function readCheck(id: string) {
  const check = await get<Check>("SELECT * FROM signal_checks WHERE id = ?", [UUID.parse(id)]);
  if (!check) throw new InputError("Check not found", 404);
  return check;
}
async function checkAllowed(row: MonitorRow, env: AgentsEnv) {
  if (!row.active) throw new InputError("Monitor is paused", 410);
  const cfg = config(row);
  if (cfg.ends_at && Date.parse(cfg.ends_at) <= Date.now()) {
    // The app gate closes before attempting the remote pause. A failed pause
    // cannot authorize research; its error stays visible for the user to retry.
    await run("UPDATE signal_monitors SET active = 0 WHERE id = ?", [row.id]);
    if (row.schedule_id) {
      try { await createAgents(env).schedules.pause(cfg.server_id, row.schedule_id); }
      catch (e) { await run("UPDATE signal_monitors SET schedule_error = ? WHERE id = ?", [message(e), row.id]); }
    }
    throw new InputError("Monitoring ended. No more research is allowed.", 410);
  }
}
function message(e: unknown) { return e instanceof Error ? e.message : "Request failed"; }
async function begin(row: MonitorRow, id: string, env: AgentsEnv) {
  await checkAllowed(row, env);
  const existing = await get<Check>("SELECT * FROM signal_checks WHERE id = ?", [id]);
  if (existing) {
    if (existing.monitor_id !== row.id) throw new InputError("Check belongs to another monitor", 409);
    return { check: existing, created: false };
  }
  // A unique partial index serializes overlapping scheduled/manual checks.
  // Never auto-expire a running check: the old agent might still be working.
  const inserted = await get<Check>(
    `INSERT INTO signal_checks(id, monitor_id, baseline)
     SELECT ?, ?, CASE WHEN ? = 0 AND NOT EXISTS
       (SELECT 1 FROM signal_checks WHERE monitor_id = ? AND status = 'done') THEN 1 ELSE 0 END
     WHERE EXISTS (SELECT 1 FROM signal_monitors WHERE id = ? AND active = 1)
     ON CONFLICT DO NOTHING RETURNING *`,
    [id, row.id, Number(config(row).include_existing), row.id, row.id]);
  if (!inserted) throw new InputError("A check is already running. Interrupt it before starting another.", 409);
  return { check: inserted, created: true };
}

export async function observationFingerprint(v: z.infer<typeof SignalObservationInput>) {
  const source = new URL(v.source_url);
  const comment = source.searchParams.get("commentUrn") ?? source.searchParams.get("replyUrn");
  // Custom findings are one subject per evidence URL. Agent prose is not an ID.
  const identity = "kind" in v ? ["custom", v.subject.type,
    v.subject.type === "company" ? normalizeDomain(v.subject.domain) : normalizeUrl(v.subject.profile_url),
    normalizeUrl(v.source_url)] : [normalizeUrl(v.profile_url), normalizeUrl(v.post_url), v.engagement,
    ["comment", "mention"].includes(v.engagement) ? (comment || v.quote.trim().replace(/\s+/g, " ")) : ""];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(identity)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export const monitorRoutes = createApp<Env>({ db: false, discovery: false });
monitorRoutes.onError((e, c) => {
  if (e instanceof z.ZodError) return c.json({ error: e.issues.map(i => i.message).join(" ") }, 400);
  if (e instanceof InputError) return c.json({ error: e.message }, e.status);
  if (e instanceof ClawnifyAgentsError)
    return c.json({ error: e.message, code: e.code, outcome_unknown: e.outcomeUnknown }, 503);
  console.error("Monitor request failed", e);
  return c.json({ error: "Monitor request failed. Refresh to check its state before retrying." }, 500);
});
monitorRoutes.use("*", async (c, next) => {
  if (c.req.raw.body !== null && ["POST", "PATCH", "PUT"].includes(c.req.method) && c.req.header("content-type")?.includes("application/json")) {
    try { if (await c.req.text()) await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  }
  await next();
});

// Control routes are deliberately absent from agent discovery: a research
// instruction must not teach its recipient to dispatch/schedule itself.
monitorRoutes.get("/api/signal-agents", async c => {
  const page = Page.parse(c.req.query("page"));
  const data = await createAgents(c.env).list({ limit: LIMIT, offset: (page - 1) * LIMIT });
  const selected = await get<{ server_id: string }>("SELECT server_id FROM agent_config WHERE id = 1");
  return c.json({ ...data, selected: selected?.server_id ?? null });
});
monitorRoutes.get("/api/monitors", async c => {
  const page = Page.parse(c.req.query("page"));
  const rows = await query<MonitorRow>("SELECT * FROM signal_monitors ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?", [LIMIT, (page - 1) * LIMIT]);
  const count = await get<{ total: number }>("SELECT COUNT(*) total FROM signal_monitors");
  return c.json({ monitors: await Promise.all(rows.map(present)), total: count?.total ?? 0, page, limit: LIMIT });
});
monitorRoutes.post("/api/monitors", async c => {
  const { id, ...body } = z.object({ id: UUID }).passthrough().parse(await c.req.json());
  const cfg = MonitorInput.parse(body);
  if (cfg.ends_at && Date.parse(cfg.ends_at) <= Date.now()) throw new InputError("Choose an end date in the future.");
  const serialized = JSON.stringify(cfg);
  await run("INSERT INTO signal_monitors(id, config, create_request) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING", [id, serialized, serialized]);
  let row = await readMonitor(id);
  // Parsed, so a row saved before a field had a default still matches its retry.
  if (JSON.stringify(MonitorInput.parse(JSON.parse(row.create_request))) !== serialized)
    throw new InputError("This creation ID was already used. Refresh before creating another monitor.", 409);
  if (cfg.frequency !== "once" && !row.schedule_id) {
    try {
      const result = await createAgents(c.env).schedules.create(cfg.server_id, {
        name: `OpenProspector: ${cfg.name}`,
        trigger: { kind: "every", every_ms: INTERVAL[cfg.frequency] },
        text: signalBrief(new URL(c.req.url).origin, id, undefined, cfg.kind),
      }, { idempotencyKey: `openprospector-monitor:${id}` });
      await run("UPDATE signal_monitors SET schedule_id = ?, schedule_error = NULL WHERE id = ?", [result.schedule.id, id]);
      // A user may have paused while create was in flight. Do not revive the
      // research gate, and reconcile the newly-discovered native job to it.
      if (!(await readMonitor(id)).active) await createAgents(c.env).schedules.pause(cfg.server_id, result.schedule.id);
    } catch (e) {
      await run("UPDATE signal_monitors SET schedule_error = ? WHERE id = ?", [message(e), id]);
      throw e;
    }
  }
  row = await readMonitor(id);
  return c.json({ monitor: await present(row) }, 201);
});
monitorRoutes.patch("/api/monitors/:id", async c => {
  const row = await readMonitor(c.req.param("id"));
  const patch = z.object({ active: z.boolean() }).strict().parse(await c.req.json());
  if (patch.active) {
    const cfg = config(row);
    if (cfg.ends_at && Date.parse(cfg.ends_at) <= Date.now()) throw new InputError("This monitor has ended. Create a new monitor to continue.");
    if (cfg.frequency !== "once" && !row.schedule_id) throw new InputError("Schedule creation is incomplete. Retry setup first.", 409);
  }
  // Pausing is effective locally even when the native clock is unreachable.
  if (!patch.active) await run("UPDATE signal_monitors SET active = 0 WHERE id = ?", [row.id]);
  if (row.schedule_id) {
    try {
      await createAgents(c.env).schedules.update(config(row).server_id, row.schedule_id, { enabled: patch.active });
    } catch (e) {
      await run("UPDATE signal_monitors SET schedule_error = ? WHERE id = ?", [message(e), row.id]);
      throw e;
    }
  }
  await run("UPDATE signal_monitors SET active = ?, schedule_error = NULL WHERE id = ?", [Number(patch.active), row.id]);
  return c.json({ monitor: await present(await readMonitor(row.id)) });
});
/**
 * Change a monitor's settings. Its native schedule follows: renamed and
 * retimed in place, or moved when the agent changes or it starts or stops
 * repeating. The old schedule is paused before a new one exists, so two
 * agents never check one monitor, and it comes back if the new one fails.
 * `request_id` keys the new schedule, so a retry after a lost response
 * replays it instead of making a second one.
 */
monitorRoutes.put("/api/monitors/:id", async c => {
  const row = await readMonitor(c.req.param("id"));
  const { request_id, ...body } = z.object({ request_id: UUID }).passthrough().parse(await c.req.json());
  const edit = MonitorEdit.parse(body);
  const before = config(row);
  if (edit.source !== undefined && edit.source !== before.source && before.kind !== "custom")
    throw new InputError("What a signal watches can't change. Create another signal to watch something else.");
  const next = MonitorInput.parse({ ...before, ...edit, source: edit.source ?? before.source });
  if (next.ends_at && next.ends_at !== before.ends_at && Date.parse(next.ends_at) <= Date.now())
    throw new InputError("Choose an end date in the future.");
  const agents = createAgents(c.env);
  const save = (scheduleId: string | null) =>
    run("UPDATE signal_monitors SET config = ?, schedule_id = ?, schedule_error = NULL WHERE id = ?", [JSON.stringify(next), scheduleId, row.id]);
  const old = row.schedule_id;
  const settings = {
    name: `OpenProspector: ${next.name}`,
    // The procedure snapshot is refreshed too, so an edit carries the current one.
    text: signalBrief(new URL(c.req.url).origin, row.id, undefined, next.kind),
  };
  if (next.frequency === "once") {
    if (old) await agents.schedules.pause(before.server_id, old);
    await save(null);
    if (old) await agents.schedules.delete(before.server_id, old).catch(() => {}); // Paused already; a leftover never runs.
  } else if (old && next.server_id === before.server_id) {
    await agents.schedules.update(before.server_id, old, { ...settings, trigger: { kind: "every", every_ms: INTERVAL[next.frequency] } });
    await save(old);
  } else {
    if (old) await agents.schedules.pause(before.server_id, old);
    let created;
    try {
      created = await agents.schedules.create(next.server_id, { ...settings, trigger: { kind: "every", every_ms: INTERVAL[next.frequency] } },
        { idempotencyKey: `openprospector-monitor:${row.id}:${request_id}` });
    } catch (e) {
      if (old && row.active) await agents.schedules.resume(before.server_id, old).catch(async () => {
        await run("UPDATE signal_monitors SET schedule_error = ? WHERE id = ?", ["The schedule was paused while moving it and could not be resumed. Pause and resume this signal.", row.id]);
      });
      throw e;
    }
    await save(created.schedule.id);
    if (old) await agents.schedules.delete(before.server_id, old).catch(() => {});
    if (!(await readMonitor(row.id)).active) {
      try { await agents.schedules.pause(next.server_id, created.schedule.id); }
      catch (e) { await run("UPDATE signal_monitors SET schedule_error = ? WHERE id = ?", [message(e), row.id]); }
    }
  }
  return c.json({ monitor: await present(await readMonitor(row.id)) });
});
monitorRoutes.post("/api/monitors/:id/run", async c => {
  const row = await readMonitor(c.req.param("id"));
  const { id } = z.object({ id: UUID }).strict().parse(await c.req.json());
  const started = await begin(row, id, c.env);
  if (!started.created) return c.json(started); // Never re-dispatch a claimed check.
  try {
    await createAgents(c.env).dispatch({
      server_id: config(row).server_id, idempotency_key: `monitor-check:${id}`,
      instruction: signalBrief(new URL(c.req.url).origin, row.id, id, config(row).kind),
    });
  } catch (e) {
    const unknown = !(e instanceof ClawnifyAgentsError) || e.outcomeUnknown;
    await run("UPDATE signal_checks SET status = ?, error = ? WHERE id = ?", [unknown ? "sourcing" : "failed", unknown ? "Dispatch outcome unknown. Do not retry; check the agent or interrupt this check." : message(e), id]);
    throw e;
  }
  return c.json(started, 202);
});
monitorRoutes.post("/api/monitor-checks/:id/interrupt", async c => {
  const check = await readCheck(c.req.param("id"));
  await run("UPDATE signal_checks SET status = 'failed', error = 'Interrupted by user', updated_at = datetime('now') WHERE id = ? AND status = 'sourcing'", [check.id]);
  return c.json({ ok: true });
});

// Agent-facing data routes are part of the live OpenAPI contract.
const CheckSchema = z.object({
  id: z.string(), monitor_id: z.string(), status: z.string(), baseline: z.number(),
  error: z.string(), coverage: z.string(), created_at: z.string(), updated_at: z.string(),
});
const MonitorSchema = MonitorInput.innerType().extend({
  id: z.string(), active: z.boolean(), schedule_id: z.string().nullable(),
  schedule_error: z.string().nullable(), created_at: z.string(),
  last_check: CheckSchema.pick({ id: true, status: true, error: true, updated_at: true, coverage: true }).nullable(),
});
function result<T extends z.ZodTypeAny>(schema: T) {
  return { description: "Result", content: { "application/json": { schema } } };
}
const MonitorResponse = result(z.object({ monitor: MonitorSchema }));
const CheckResponse = result(z.object({ check: CheckSchema }));
const BeginResponse = result(z.object({ check: CheckSchema, created: z.boolean() }));
const ObservationsResponse = result(z.object({ recorded: z.number(), baseline: z.boolean(),
  remaining: z.number().nullable().describe("New findings this check may still record; null on a baseline check"),
  limit_reached: z.boolean().describe("The monitor's max_per_check is used up: stop and finish the check as done") }));
const IdParam = z.object({ id: UUID });
monitorRoutes.openapi(createRoute({ method: "get", path: "/api/monitors/{id}", tags: ["Monitoring"],
  summary: "Read a monitor's current settings before researching", request: { params: IdParam }, responses: { 200: MonitorResponse } }),
  async c => c.json({ monitor: await present(await readMonitor(c.req.param("id"))) }, 200));
monitorRoutes.openapi(createRoute({ method: "post", path: "/api/monitors/{id}/checks", tags: ["Monitoring"],
  summary: "Claim a scheduled check before researching; 409/410 means stop", request: { params: IdParam,
    body: { content: { "application/json": { schema: z.object({ id: UUID }).strict() } } } }, responses: { 200: BeginResponse } }),
  async c => c.json(await begin(await readMonitor(c.req.param("id")), c.req.valid("json").id, c.env), 200));
monitorRoutes.openapi(createRoute({ method: "get", path: "/api/monitor-checks/{id}", tags: ["Monitoring"],
  summary: "Read check progress; only sourcing checks accept findings", request: { params: IdParam }, responses: { 200: CheckResponse } }),
  async c => c.json({ check: await readCheck(c.req.param("id")) }, 200));
monitorRoutes.openapi(createRoute({ method: "patch", path: "/api/monitor-checks/{id}", tags: ["Monitoring"],
  summary: "Heartbeat or finish a check with coverage or an actionable error", request: { params: IdParam,
    body: { content: { "application/json": { schema: z.object({ status: z.enum(["sourcing", "done", "failed"]), coverage: z.string().max(2000).optional(), error: z.string().max(1000).optional() }).strict() } } } }, responses: { 200: CheckResponse } }),
  async c => {
    const check = await readCheck(c.req.param("id"));
    const body = c.req.valid("json");
    if (check.status !== "sourcing") throw new InputError("Check is already finished or interrupted", 409);
    if (body.status === "done" && !body.coverage?.trim()) throw new InputError("Describe coverage before completing the check.");
    if (body.status === "failed" && !body.error?.trim()) throw new InputError("Explain why the check failed.");
    await run("UPDATE signal_checks SET status = ?, coverage = ?, error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'sourcing'", [body.status, body.coverage ?? check.coverage, body.error ?? "", check.id]);
    return c.json({ check: await readCheck(check.id) }, 200);
  });
monitorRoutes.openapi(createRoute({ method: "post", path: "/api/monitor-checks/{id}/observations", tags: ["Monitoring"],
  summary: "Record person/company findings; repeats, baseline and the monitor's max_per_check are handled atomically. Custom monitors also accept legacy LinkedIn observations.", request: { params: IdParam,
    body: { content: { "application/json": { schema: z.object({ observations: z.array(SignalObservationInput).min(1).max(25) }).strict() } } } }, responses: { 200: ObservationsResponse } }),
  async c => {
    const check = await readCheck(c.req.param("id"));
    const monitor = await readMonitor(check.monitor_id);
    await checkAllowed(monitor, c.env);
    if (check.status !== "sourcing") throw new InputError("Check is not running", 409);
    const observations = c.req.valid("json").observations;
    if (config(monitor).kind !== "custom" && observations.some(v => "kind" in v))
      throw new InputError("LinkedIn templates require LinkedIn engagement observations.");
    // Accept the old LinkedIn shape on custom monitors: already-running tasks
    // and native schedules may still carry the previously attached snapshot.
    let recorded = 0;
    // A signal that feeds a list adds its new people to it as they are found,
    // and opens a search for the person to contact at each new company:
    // attaching it to the list was the review. Baseline findings stay hidden.
    const feeds = !check.baseline && (await listsFedBy("signal", check.monitor_id)).length > 0;
    const grew = new Set<string>();
    const companies: Company[] = [];
    const cap = config(monitor).max_per_check;
    for (const observation of observations) {
      const fingerprint = await observationFingerprint(observation);
      const inserted = await get<{ id: string }>(
        `INSERT INTO signal_observations(id, monitor_id, check_id, fingerprint, details, visible)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS
           (SELECT 1 FROM signal_checks c JOIN signal_monitors m ON m.id = c.monitor_id
            WHERE c.id = ? AND c.status = 'sourcing' AND m.active = 1)
           -- A baseline is uncapped: it hides what already exists.
           AND (? = 1 OR (SELECT COUNT(*) FROM signal_observations WHERE check_id = ? AND visible = 1) < ?)
         ON CONFLICT(monitor_id, fingerprint) DO NOTHING RETURNING id`,
        [crypto.randomUUID(), check.monitor_id, check.id, fingerprint, JSON.stringify(observation), check.baseline ? 0 : 1, check.id,
          check.baseline, check.id, cap]);
      if (inserted) {
        recorded++;
        if (feeds && isPerson(observation)) {
          const leadId = await promoteObservation(inserted.id, JSON.stringify(observation));
          for (const listId of await joinFromSignal(check.monitor_id, leadId)) grew.add(listId);
        } else if (feeds) {
          const company = companyOf(JSON.stringify(observation));
          if (company) companies.push(company);
        }
      }
    }
    if (companies.length) {
      const { name, who_to_contact } = config(monitor);
      for (const listId of await searchCompanies(c.env, new URL(c.req.url).origin, { id: monitor.id, name, who_to_contact }, companies)) grew.add(listId);
    }
    await afterJoin(c.env, new URL(c.req.url).origin, [...grew]);
    if (check.baseline) return c.json({ recorded, baseline: true, remaining: null, limit_reached: false }, 200);
    const found = await get<{ n: number }>("SELECT COUNT(*) n FROM signal_observations WHERE check_id = ? AND visible = 1", [check.id]);
    const remaining = Math.max(0, cap - (found?.n ?? 0));
    return c.json({ recorded, baseline: false, remaining, limit_reached: remaining === 0 }, 200);
  });
interface SearchColumns { search_id: string | null; search_status: string; search_error: string; search_lead_count: number; search_stale: number }
/** Findings with the search opened for the company each names, shared by every finding of that company. */
const FINDINGS = `SELECT o.*, r.id AS search_id, r.status AS search_status, r.error AS search_error, r.lead_count AS search_lead_count,
    (CASE WHEN r.status IN ('sourcing', 'enriching') AND r.updated_at < datetime('now', ?) THEN 1 ELSE 0 END) AS search_stale
  FROM signal_observations o LEFT JOIN runs r ON r.company_domain = json_extract(o.details, '$.subject.domain')`;
function finding({ details, search_id, search_status, search_error, search_lead_count, search_stale, ...row }: ObservationRow & SearchColumns): Observation {
  const search = search_id ? { id: search_id, status: search_status, error: search_error ?? "", lead_count: search_lead_count, stale: search_stale } : null;
  return { ...row, ...JSON.parse(details), search } as Observation;
}
monitorRoutes.get("/api/monitor-observations", async c => {
  const page = Page.parse(c.req.query("page"));
  const rows = await query<ObservationRow & SearchColumns>(`${FINDINGS} WHERE o.visible = 1 ORDER BY o.observed_at DESC, o.rowid DESC LIMIT ? OFFSET ?`, [STALE_AFTER, LIMIT, (page - 1) * LIMIT]);
  const count = await get<{ total: number }>("SELECT COUNT(*) total FROM signal_observations WHERE visible = 1");
  return c.json({ observations: rows.map(finding), total: count?.total ?? 0, page, limit: LIMIT });
});
/** Whether a finding is about a person, the only kind that can become a lead. */
function isPerson(data: z.infer<typeof SignalObservationInput>): boolean {
  return !("kind" in data) || data.subject.type === "person";
}

/**
 * "Add to people": a person finding becomes a lead, once. Shared by the
 * button and by a signal that feeds a list, where attaching the signal was
 * the review.
 */
export async function promoteObservation(observationId: string, details: string): Promise<string> {
  const data = SignalObservationInput.parse(JSON.parse(details));
  if (!isPerson(data)) throw new InputError("Company findings cannot be added to people.");
  const person = "kind" in data && data.subject.type === "person" ? data.subject : null;
  const profile = normalizeUrl("kind" in data ? person!.profile_url : data.profile_url);
  const isLinkedin = linkedinUrl(profile, "profile");
  const existing = isLinkedin ? await get<{ id: string }>("SELECT id FROM leads WHERE linkedin_url = ? LIMIT 1", [profile]) : null;
  // Deterministic ID makes simultaneous promotion of one person idempotent.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(profile));
  const leadId = existing?.id ?? `${isLinkedin ? "linkedin" : "person"}-${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}`;
  await run(`INSERT INTO leads(id, full_name, linkedin_url, company, domain, source, source_url, evidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    "kind" in data ? [leadId, person!.name, isLinkedin ? profile : "", "", "", "custom", data.source_url,
      `Profile: ${person!.profile_url}\n${data.summary}\nSignal reason: ${data.reason}`] :
    [leadId, data.person_name, profile, data.company, normalizeDomain(data.domain), "linkedin", data.source_url,
      `${data.engagement}: ${data.quote}\nICP fit: ${data.why_fit}\nContext: ${data.outreach_context}`]);
  await run("UPDATE signal_observations SET lead_id = ? WHERE id = ?", [leadId, observationId]);
  return leadId;
}

/**
 * "Find people": the search for the person to contact at the company a finding
 * names. Opens it and hands it to the agent, or, when another finding of that
 * company already opened one, uses that search and its people.
 */
monitorRoutes.post("/api/monitor-observations/:id/search", async c => {
  const row = await get<ObservationRow>("SELECT * FROM signal_observations WHERE id = ? AND visible = 1", [UUID.parse(c.req.param("id"))]);
  if (!row) throw new InputError("Finding not found", 404);
  const company = companyOf(row.details);
  if (!company) throw new InputError("Only a company finding has people to find.");
  const { name, who_to_contact } = config(await readMonitor(row.monitor_id));
  const origin = new URL(c.req.url).origin;
  await afterJoin(c.env, origin, await searchCompanies(c.env, origin, { id: row.monitor_id, name, who_to_contact }, [company]));
  const updated = await get<ObservationRow & SearchColumns>(`${FINDINGS} WHERE o.id = ?`, [STALE_AFTER, row.id]);
  return c.json({ observation: finding(updated!) });
});
monitorRoutes.post("/api/monitor-observations/:id/lead", async c => {
  const row = await get<ObservationRow>("SELECT * FROM signal_observations WHERE id = ? AND visible = 1", [UUID.parse(c.req.param("id"))]);
  if (!row) throw new InputError("Finding not found", 404);
  const leadId = await promoteObservation(row.id, row.details);
  // Someone added by hand from a signal that feeds lists joins them too.
  await afterJoin(c.env, new URL(c.req.url).origin, await joinFromSignal(row.monitor_id, leadId));
  return c.json({ lead_id: leadId });
});
