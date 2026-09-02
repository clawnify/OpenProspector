import { createApp, createRoute, z } from "@clawnify/app";
import { enqueueJob, verifyDelivery } from "@clawnify/queue";
import type { CredentialBinding } from "@clawnify/connections";
import { get, query, run } from "./db.js";
import { d1Cache, recordAttempts, runCredits } from "./cache.js";
import { REGISTRY, defaultOrder, providerById, CACHE_MAX_AGE_DAYS } from "./providers/index.js";
import { plannedForField } from "./providers/planned.js";
import {
  FIELDS,
  CALLBACK_TIMEOUT_MINUTES,
  cancelPending,
  enrichLead,
  expireOverdue,
  finishRunIfDrained,
  resumeLead,
  type EnrichEnv,
  type EnrichOptions,
} from "./enrich.js";
import { EXPORT_COLUMNS, columnsFor, toCsv, toExportRows, checkDestination, safeHeaders, pushVerdict } from "./export.js";
import { dispatchAvailable, dispatchTask, listAgentServers, sourcingBrief } from "./agent.js";
import type { EnrichField, EnrichResult } from "./providers/types.js";

type Env = {
  Bindings: {
    DB: D1Database;
    CREDENTIALS?: CredentialBinding;
    CLAWNIFY_ORG_ID?: string;
    /** Minted per org by the platform; required by the queue and agent services. */
    CLAWNIFY_TOKEN?: string;
    /** Override the platform agent endpoint — local testing only. */
    CLAWNIFY_AGENTS_URL?: string;
    /** Vendor keys arrive as injected secrets, read via secret() in the adapters. */
    FINDYMAIL_API_KEY?: string;
  };
};

const app = createApp<Env>({
  title: "OpenProspector",
  version: "1.0.0",
  description:
    "Find and enrich B2B leads with your own provider keys. ICP search, a configurable enrichment waterfall, and export — no markup, no per-lead pricing.",
});

// ── Shared schemas ──────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const OkSchema = z.object({ ok: z.boolean() }).openapi("Ok");

const PaginationQuery = z.object({
  page: z.string().optional().openapi({ description: "Page number (default: 1)" }),
  limit: z.string().optional().openapi({ description: "Items per page (default: 25, max: 100)" }),
  search: z.string().optional().openapi({ description: "Free-text match on name, company, domain, title" }),
});

const LeadSchema = z
  .object({
    id: z.string(),
    run_id: z.string().nullable(),
    full_name: z.string(),
    title: z.string(),
    company: z.string(),
    domain: z.string(),
    linkedin_url: z.string(),
    location: z.string(),
    source: z.string(),
    source_url: z.string(),
    evidence: z.string(),
    email: z.string(),
    email_verified: z.number().int(),
    email_provider: z.string(),
    phone: z.string(),
    phone_verified: z.number().int(),
    phone_provider: z.string(),
    enrich_status: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Lead");

const RunSchema = z
  .object({
    id: z.string(),
    icp_prompt: z.string(),
    status: z.string(),
    lead_count: z.number().int(),
    credits_spent: z.number().int(),
    error: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    /**
     * Computed by the server, not stored: a run the agent claimed but stopped
     * reporting on. Derived in SQL so both sides use the database's clock —
     * comparing a browser's Date.now() against a UTC datetime() string is how
     * you get a run that looks stalled in one timezone and fine in another.
     */
    stale: z.number().int().openapi({ description: "1 when a sourcing run has gone quiet past the staleness window" }),
  })
  .openapi("Run");

/**
 * Row types are derived from the response schemas, so a column rename that
 * breaks the API contract fails the typecheck instead of shipping.
 */
type LeadRow = z.infer<typeof LeadSchema>;
type RunRow = z.infer<typeof RunSchema>;

const AttemptSchema = z
  .object({
    provider_id: z.string(),
    field: z.string(),
    outcome: z.string(),
    credits_used: z.number().int(),
    ms: z.number().int(),
    detail: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("EnrichAttempt");

type AttemptRow = z.infer<typeof AttemptSchema>;

/**
 * How long a run may sit in `sourcing` without an update before the UI calls it
 * stalled. Agent turns are legitimately slow (minutes), so this is generous;
 * it exists to catch an agent that died mid-task, which is the one failure the
 * app cannot otherwise distinguish from "still working".
 */
const STALE_AFTER = "-15 minutes";

/**
 * Every runs read goes through this so `stale` can never drift between routes.
 *
 * Covers `enriching` as well as `sourcing`: a queued enrichment that never got
 * delivered leaves the run mid-flight with nothing to report the failure, which
 * looked identical to one still working. Both in-flight states now have a clock.
 * The enrich job heartbeats `updated_at` per batch so a long, healthy run is
 * never mistaken for a dead one.
 */
const RUN_SELECT =
  `*, (CASE WHEN status IN ('sourcing', 'enriching') AND updated_at < datetime('now', ?) THEN 1 ELSE 0 END) AS stale`;

function isField(v: string): v is EnrichField {
  return (FIELDS as string[]).includes(v);
}

/** Page/limit parsing shared by every list route, clamped so no caller can ask for the table. */
function paging(q: { page?: string; limit?: string }) {
  const page = Math.max(1, parseInt(q.page || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit || "25", 10) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

/**
 * The user's configured waterfall for a field, falling back to the shipping
 * default for that field. Unknown ids are dropped here rather than in the runner
 * so a vendor removed from the registry can't wedge an existing config.
 */
async function waterfallOrder(field: EnrichField): Promise<string[]> {
  const row = await get<{ provider_order: string }>(
    "SELECT provider_order FROM waterfall_config WHERE field = ?",
    [field],
  );
  const known = defaultOrder(field);
  if (!row?.provider_order) return known;
  try {
    const parsed = JSON.parse(row.provider_order) as unknown;
    if (!Array.isArray(parsed)) return known;
    return parsed.filter((id): id is string => typeof id === "string" && known.includes(id));
  } catch {
    return known;
  }
}

// ── Providers & waterfall configuration ─────────────────────────────

const listProviders = createRoute({
  method: "get",
  path: "/api/providers",
  tags: ["Providers"],
  summary: "List enrichment providers, which are configured, and the current waterfall order",
  request: {
    query: z.object({
      credits: z.string().optional().openapi({ description: "Set to 'true' to also fetch remaining balances (slower — one call per vendor)" }),
    }),
  },
  responses: {
    200: {
      description: "Provider registry with configuration state",
      content: {
        "application/json": {
          schema: z.object({
            providers: z.array(
              z.object({
                id: z.string(),
                label: z.string(),
                fields: z.array(z.string()),
                secret_name: z.string(),
                signup_url: z.string(),
                configured: z.boolean(),
                status: z.enum(["available", "planned"]),
                key_format: z.string().optional().openapi({
                  description: "Shape of the secret when it is not an opaque key (e.g. Forager's 'accountId:apiKey')",
                }),
                deferred: z.array(z.string()).optional().openapi({
                  description: "Fields the vendor answers by callback: a lead reaching it for one of these waits (up to the callback timeout) instead of resolving in the same pass",
                }),
                blocked_by: z.string().optional().openapi({
                  description: "Why a planned vendor is not shipped yet",
                }),
                credits_remaining: z.number().nullable().optional(),
              }),
            ),
            waterfalls: z.record(z.string(), z.array(z.string())),
            cache_max_age_days: z.number().int(),
            callback_timeout_minutes: z.number().int(),
          }),
        },
      },
    },
  },
});

app.openapi(listProviders, async (c) => {
  const wantCredits = c.req.valid("query").credits === "true";
  const providers = await Promise.all(
    REGISTRY.map(async (p) => {
      // Read through the same accessor the adapters use, so "configured" here
      // can never disagree with whether the waterfall will actually call it.
      const key = (c.env as Record<string, unknown>)[p.secretName];
      const configured = typeof key === "string" && key.length > 0;
      let creditsRemaining: number | null | undefined;
      if (wantCredits && configured && p.credits) {
        try {
          creditsRemaining = (await p.credits(key as string)).remaining;
        } catch {
          creditsRemaining = null;
        }
      }
      return {
        id: p.id,
        label: p.label,
        fields: [...p.fields],
        secret_name: p.secretName,
        signup_url: p.signupUrl,
        configured,
        status: "available" as "available" | "planned",
        ...(p.keyFormat ? { key_format: p.keyFormat } : {}),
        ...(p.deferred ? { deferred: [...p.deferred] } : {}),
        ...(wantCredits ? { credits_remaining: creditsRemaining ?? null } : {}),
      };
    }),
  );

  // Roadmap vendors, declared but not implemented. Appended so the settings
  // screen shows the intended waterfall depth per field; they carry
  // status:"planned" so the UI can badge them rather than imply they run.
  const plannedIds = new Set<string>();
  // Widened: only a planned vendor carries `blocked_by`, so the shipped rows'
  // inferred shape does not include it.
  const planned: ((typeof providers)[number] & { blocked_by?: string })[] = [];
  for (const f of FIELDS) {
    for (const pp of plannedForField(f)) {
      if (plannedIds.has(pp.id)) continue;
      plannedIds.add(pp.id);
      planned.push({
        id: pp.id,
        label: pp.label,
        fields: [...pp.fields],
        secret_name: `${pp.id.toUpperCase()}_API_KEY`,
        signup_url: pp.homepage,
        configured: false,
        status: "planned" as const,
        blocked_by: pp.blockedBy,
        ...(wantCredits ? { credits_remaining: null } : {}),
      });
    }
  }

  // Display order: what actually runs first, then the roadmap in intended
  // position. The runner reads waterfallOrder() separately and only ever sees
  // implemented ids, so a planned vendor can never be dispatched to.
  const waterfalls: Record<string, string[]> = {};
  for (const f of FIELDS) {
    waterfalls[f] = [...(await waterfallOrder(f)), ...plannedForField(f).map((p) => p.id)];
  }

  return c.json(
    {
      providers: [...providers, ...planned],
      waterfalls,
      cache_max_age_days: CACHE_MAX_AGE_DAYS,
      callback_timeout_minutes: CALLBACK_TIMEOUT_MINUTES,
    },
    200,
  );
});

const putWaterfall = createRoute({
  method: "put",
  path: "/api/waterfall/{field}",
  tags: ["Providers"],
  summary: "Set the provider order for one field's waterfall",
  request: {
    params: z.object({ field: z.string().openapi({ description: "email | phone" }) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ order: z.array(z.string()).openapi({ description: "Provider ids, highest priority first" }) }),
        },
      },
    },
  },
  responses: {
    200: { description: "Saved order", content: { "application/json": { schema: z.object({ field: z.string(), order: z.array(z.string()) }) } } },
    400: { description: "Bad field or order", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(putWaterfall, async (c) => {
  const field = c.req.valid("param").field;
  if (!isField(field)) return c.json({ error: `Unknown field '${field}'` }, 400);

  const known = REGISTRY.filter((p) => p.fields.includes(field)).map((p) => p.id);
  const order = c.req.valid("json").order.filter((id) => known.includes(id));
  if (order.length === 0) return c.json({ error: "Order must contain at least one provider that can resolve this field" }, 400);

  await run(
    `INSERT INTO waterfall_config (field, provider_order, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(field) DO UPDATE SET provider_order = excluded.provider_order, updated_at = excluded.updated_at`,
    [field, JSON.stringify(order)],
  );
  return c.json({ field, order }, 200);
});

// ── Runs ────────────────────────────────────────────────────────────

const createRun = createRoute({
  method: "post",
  path: "/api/runs",
  tags: ["Runs"],
  summary: "Start a search from an ICP description",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            // Bounded so the sourcing brief built from it always fits inside the
            // platform's 4000-character instruction cap — an ICP that silently
            // got truncated on the way to the agent is worse than one refused.
            icp_prompt: z
              .string()
              .min(3)
              .max(2000)
              .openapi({ description: "Natural-language ideal-customer profile, or a domain to model" }),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Run created", content: { "application/json": { schema: z.object({ run: RunSchema }) } } },
  },
});

app.openapi(createRun, async (c) => {
  const id = crypto.randomUUID();
  await run("INSERT INTO runs (id, icp_prompt, status) VALUES (?, ?, 'pending')", [
    id,
    c.req.valid("json").icp_prompt,
  ]);
  const row = (await get<RunRow>(`SELECT ${RUN_SELECT} FROM runs WHERE id = ?`, [STALE_AFTER, id]))!;
  return c.json({ run: row }, 201);
});

const listRuns = createRoute({
  method: "get",
  path: "/api/runs",
  tags: ["Runs"],
  summary: "List runs with pagination",
  request: { query: PaginationQuery },
  responses: {
    200: {
      description: "Paginated runs",
      content: {
        "application/json": {
          schema: z.object({ runs: z.array(RunSchema), total: z.number().int(), page: z.number().int(), limit: z.number().int() }),
        },
      },
    },
  },
});

app.openapi(listRuns, async (c) => {
  const q = c.req.valid("query");
  const { page, limit, offset } = paging(q);
  const search = (q.search || "").trim();
  const where = search ? " WHERE icp_prompt LIKE ?" : "";
  const params = search ? [`%${search}%`] : [];

  const countRow = await get<{ total: number }>("SELECT COUNT(*) AS total FROM runs" + where, params);
  const runs = await query<RunRow>(
    `SELECT ${RUN_SELECT} FROM runs${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
    [STALE_AFTER, ...params, limit, offset],
  );
  return c.json({ runs, total: countRow?.total || 0, page, limit }, 200);
});

const getRun = createRoute({
  method: "get",
  path: "/api/runs/{id}",
  tags: ["Runs"],
  summary: "Get one run with live credit spend",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Run", content: { "application/json": { schema: z.object({ run: RunSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getRun, async (c) => {
  const id = c.req.valid("param").id;
  const row = await get<RunRow>(`SELECT ${RUN_SELECT} FROM runs WHERE id = ?`, [STALE_AFTER, id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  // Spend is read back from the ledger rather than trusted from the counter, so
  // a crashed job can never leave a run under-reporting what it cost.
  return c.json({ run: { ...row, credits_spent: await runCredits(id) } }, 200);
});

const RUN_STATUSES = ["pending", "sourcing", "enriching", "done", "failed"] as const;

const patchRun = createRoute({
  method: "patch",
  path: "/api/runs/{id}",
  tags: ["Runs"],
  summary: "Report progress on a run (the agent calls this while sourcing)",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum(RUN_STATUSES).optional(),
            error: z.string().optional().openapi({ description: "Why it failed. Required in spirit when status is 'failed' — an unexplained failure is not actionable." }),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated run", content: { "application/json": { schema: z.object({ run: RunSchema }) } } },
    400: { description: "Nothing to update", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(patchRun, async (c) => {
  const id = c.req.valid("param").id;
  const body = c.req.valid("json");

  const exists = await get("SELECT id FROM runs WHERE id = ?", [id]);
  if (!exists) return c.json({ error: "Not found" }, 404);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.status) {
    sets.push("status = ?");
    params.push(body.status);
  }
  if (body.error !== undefined) {
    sets.push("error = ?");
    params.push(body.error.slice(0, 2000));
  }
  if (sets.length === 0) return c.json({ error: "Provide status and/or error" }, 400);

  // lead_count is deliberately NOT settable: it is derived from the leads table
  // on import, so accepting it here would let a reported number drift from the
  // rows actually present.
  sets.push("updated_at = datetime('now')");
  await run(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);

  const updated = (await get<RunRow>(`SELECT ${RUN_SELECT} FROM runs WHERE id = ?`, [STALE_AFTER, id]))!;
  return c.json({ run: updated }, 200);
});

// ── Agent handoff ───────────────────────────────────────────────────
//
// Sourcing runs on the org's agent, not in this app: it needs judgment, a real
// browser, and minutes of runtime. These routes are the handoff.
//
// They are deliberately NOT on the OpenAPI surface. The agent is the *target* of
// a dispatch, so publishing `/dispatch` would let it hand work to itself — a
// loop the app would have no way to break — and every published route costs
// context in every agent turn. The agent's side of this contract is the two
// routes it already has: PATCH /api/runs/{id} and POST /api/leads.

/** The chosen agent, or null to let the platform resolve a single-agent org. */
async function configuredServerId(): Promise<string | null> {
  const row = await get<{ server_id: string }>("SELECT server_id FROM agent_config WHERE id = 1");
  return row?.server_id || null;
}

app.get("/api/agent", async (c) => {
  const servers = await listAgentServers(c.env);
  return c.json({
    // Distinct on purpose: "this deployment has no platform token" (off-platform)
    // is a different problem from "the platform didn't answer" (transient).
    available: dispatchAvailable(c.env),
    reachable: servers !== null,
    server_id: await configuredServerId(),
    servers: servers ?? [],
  });
});

app.put("/api/agent", async (c) => {
  let body: { server_id?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const wanted = typeof body.server_id === "string" ? body.server_id.trim() : "";

  // Validated against the live list rather than stored blind: a mistyped or
  // decommissioned id would otherwise wedge every future dispatch behind a
  // platform 404 the user has no way to interpret.
  if (wanted) {
    const servers = await listAgentServers(c.env);
    if (servers === null) return c.json({ error: "Can't reach the platform to verify that agent." }, 503);
    if (!servers.some((s) => s.id === wanted)) return c.json({ error: "That agent isn't in your organization." }, 400);
  }

  await run(
    `INSERT INTO agent_config (id, server_id, updated_at) VALUES (1, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET server_id = excluded.server_id, updated_at = excluded.updated_at`,
    [wanted],
  );
  return c.json({ server_id: wanted || null });
});

/**
 * Hand a run to the agent.
 *
 * Kept separate from run creation deliberately: the run is a durable record the
 * moment the user describes an ICP, and a dispatch failure must not erase it.
 * The same call then serves as the retry for a run whose agent died mid-task.
 */
app.post("/api/runs/:id/dispatch", async (c) => {
  const runId = c.req.param("id");
  const row = await get<RunRow>(`SELECT ${RUN_SELECT} FROM runs WHERE id = ?`, [STALE_AFTER, runId]);
  if (!row) return c.json({ error: "Run not found" }, 404);

  // Refuse to dispatch work already in flight. A *stalled* sourcing run falls
  // through on purpose — that is exactly the case worth retrying.
  if ((row.status === "sourcing" && !row.stale) || row.status === "enriching") {
    return c.json({ error: "This search is already running." }, 409);
  }
  if (row.status === "done") return c.json({ error: "This search has already finished." }, 409);

  const brief = sourcingBrief({ runId, prompt: row.icp_prompt, appUrl: new URL(c.req.url).origin });

  // Idempotency key = run id + the row's current updated_at. A double-click
  // carries the same key (nothing has changed yet) so the platform delivers
  // once; a genuine retry later carries a different one, because a successful
  // dispatch bumps updated_at. Keying on the run id alone would look safer and
  // silently swallow every retry for 24 hours — the worse failure.
  const result = await dispatchTask(c.env, {
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
    return c.json({ error: result.error, brief, servers: result.servers ?? [] }, 502);
  }

  await run("UPDATE runs SET status = 'sourcing', error = '', updated_at = datetime('now') WHERE id = ?", [runId]);
  return c.json(
    { dispatched: true, task_id: result.taskId, server_id: result.serverId, duplicate: result.duplicate },
    202,
  );
});

// ── Leads ───────────────────────────────────────────────────────────

const listLeads = createRoute({
  method: "get",
  path: "/api/leads",
  tags: ["Leads"],
  summary: "List leads with pagination, search, and filters",
  request: {
    query: PaginationQuery.extend({
      run_id: z.string().optional().openapi({ description: "Restrict to one run" }),
      enrich_status: z.string().optional().openapi({ description: "pending | running | waiting | done | failed" }),
      has_email: z.string().optional().openapi({ description: "'true' for leads with a resolved email, 'false' for those without" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated leads",
      content: {
        "application/json": {
          schema: z.object({ leads: z.array(LeadSchema), total: z.number().int(), page: z.number().int(), limit: z.number().int() }),
        },
      },
    },
  },
});

app.openapi(listLeads, async (c) => {
  const q = c.req.valid("query");
  const { page, limit, offset } = paging(q);

  const where: string[] = [];
  const params: unknown[] = [];
  const search = (q.search || "").trim();
  if (search) {
    where.push("(full_name LIKE ? OR company LIKE ? OR domain LIKE ? OR title LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (q.run_id) {
    where.push("run_id = ?");
    params.push(q.run_id);
  }
  if (q.enrich_status) {
    where.push("enrich_status = ?");
    params.push(q.enrich_status);
  }
  if (q.has_email === "true") where.push("email != ''");
  if (q.has_email === "false") where.push("email = ''");

  const whereSQL = where.length ? " WHERE " + where.join(" AND ") : "";
  const countRow = await get<{ total: number }>("SELECT COUNT(*) AS total FROM leads" + whereSQL, params);
  const leads = await query<LeadRow>(`SELECT * FROM leads${whereSQL} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  return c.json({ leads, total: countRow?.total || 0, page, limit }, 200);
});

/**
 * Max leads per import call. Keeps the insert inside D1's bound-parameter
 * budget and stops a single request from queueing an unbounded spend; larger
 * files page through this endpoint.
 */
const MAX_IMPORT = 500;

const importLeads = createRoute({
  method: "post",
  path: "/api/leads",
  tags: ["Leads"],
  summary: "Import leads to enrich (CSV upload or an existing list)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            run_id: z.string().optional().openapi({ description: "Attach to an existing run" }),
            leads: z
              .array(
                z.object({
                  full_name: z.string().optional(),
                  title: z.string().optional(),
                  company: z.string().optional(),
                  domain: z.string().optional(),
                  linkedin_url: z.string().optional(),
                  location: z.string().optional(),
                  source: z.string().optional(),
                  source_url: z.string().optional(),
                  evidence: z.string().optional(),
                }),
              )
              .min(1)
              .max(MAX_IMPORT),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Imported", content: { "application/json": { schema: z.object({ imported: z.number().int(), run_id: z.string().nullable() }) } } },
    400: { description: "Nothing importable", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(importLeads, async (c) => {
  const body = c.req.valid("json");
  // A lead with neither a name nor a domain can't be enriched by any provider,
  // so reject it at the boundary instead of storing a row that will only ever
  // produce "ineligible" attempts.
  const rows = body.leads.filter((l) => (l.full_name || "").trim() || (l.domain || "").trim());
  if (rows.length === 0) return c.json({ error: "Every lead needs at least a full_name or a domain" }, 400);

  const runId = body.run_id ?? null;
  // 11 params per row; chunked to stay under D1's 100-bound-parameter cap.
  for (let i = 0; i < rows.length; i += 9) {
    const slice = rows.slice(i, i + 9);
    const values = slice.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = slice.flatMap((l) => [
      crypto.randomUUID(),
      runId,
      (l.full_name || "").trim(),
      (l.title || "").trim(),
      (l.company || "").trim(),
      (l.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0],
      (l.linkedin_url || "").trim(),
      (l.location || "").trim(),
      (l.source || "import").trim(),
      (l.source_url || "").trim(),
      // Was omitted from the INSERT while being accepted and documented as
      // required — the citation silently vanished on every import.
      (l.evidence || "").trim(),
    ]);
    await run(
      `INSERT INTO leads (id, run_id, full_name, title, company, domain, linkedin_url, location, source, source_url, evidence)
       VALUES ${values}`,
      params,
    );
  }

  if (runId) {
    await run(
      "UPDATE runs SET lead_count = (SELECT COUNT(*) FROM leads WHERE run_id = ?), updated_at = datetime('now') WHERE id = ?",
      [runId, runId],
    );
  }
  return c.json({ imported: rows.length, run_id: runId }, 201);
});

const getLead = createRoute({
  method: "get",
  path: "/api/leads/{id}",
  tags: ["Leads"],
  summary: "Get one lead with the waterfall attempt log that produced it",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Lead with attribution",
      content: {
        "application/json": {
          schema: z.object({
            lead: LeadSchema,
            attempts: z.array(AttemptSchema),
          }),
        },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getLead, async (c) => {
  const id = c.req.valid("param").id;
  const lead = await get<LeadRow>("SELECT * FROM leads WHERE id = ?", [id]);
  if (!lead) return c.json({ error: "Not found" }, 404);
  // Bounded: a single lead's waterfall is at most a few rows per field, but the
  // cap keeps a pathological retry loop out of the agent's context.
  const attempts = await query<AttemptRow>(
    "SELECT provider_id, field, outcome, credits_used, ms, detail, created_at FROM enrichment_attempts WHERE lead_id = ? ORDER BY created_at LIMIT 50",
    [id],
  );
  return c.json({ lead, attempts }, 200);
});

// ── Enrichment ──────────────────────────────────────────────────────

/**
 * Leads enriched per queue delivery. Each lead costs one fetch per provider it
 * reaches, so this bounds subrequests per job; the job re-enqueues itself for
 * the next slice rather than looping over the whole run in one request.
 */
const BATCH_SIZE = 10;

/** Both waterfalls' configured order, read once per batch rather than per lead. */
async function enrichOptions(c: { req: { url: string } }, refresh = false): Promise<EnrichOptions> {
  return {
    orders: { email: await waterfallOrder("email"), phone: await waterfallOrder("phone") },
    // The app's own origin — no configured base URL to drift from reality.
    origin: new URL(c.req.url).origin,
    refresh,
  };
}

const startEnrich = createRoute({
  method: "post",
  path: "/api/runs/{id}/enrich",
  tags: ["Enrichment"],
  summary: "Enqueue enrichment for every pending lead in a run",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    202: { description: "Enrichment queued", content: { "application/json": { schema: z.object({ queued: z.boolean(), pending: z.number().int() }) } } },
    404: { description: "Run not found", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Queue unavailable", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(startEnrich, async (c) => {
  const runId = c.req.valid("param").id;
  const existing = await get<{ updated_at: string }>("SELECT updated_at FROM runs WHERE id = ?", [runId]);
  if (!existing) return c.json({ error: "Run not found" }, 404);

  const pendingRow = await get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM leads WHERE run_id = ? AND enrich_status = 'pending'",
    [runId],
  );
  const pending = pendingRow?.n || 0;
  if (pending === 0) return c.json({ queued: false, pending: 0 }, 202);

  // Attempt token, same reasoning as the agent dispatch above. The queue's
  // idempotency key returns the EXISTING job on a repeat — so a key of
  // `enrich:<run>:0` made a run's enrichment enqueueable exactly once ever: any
  // job that failed to deliver left the run unretryable, silently, because the
  // retry got handed back the dead job and still answered 202. The run's
  // updated_at changes on every state transition, so a double-click reuses the
  // token (deduped, correctly) while a real retry gets a fresh one. It travels
  // in the payload so the batch chain stays unique within one attempt.
  const attempt = existing.updated_at;

  try {
    await enqueueJob(c.env, {
      // The app's own origin — no configured base URL to drift from reality.
      targetUrl: `${new URL(c.req.url).origin}/api/jobs/enrich`,
      payload: { runId, batch: 0, attempt },
      idempotencyKey: `enrich:${runId}:${attempt}:0`,
      maxAttempts: 3,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 503);
  }
  await run("UPDATE runs SET status = 'enriching', updated_at = datetime('now') WHERE id = ?", [runId]);
  return c.json({ queued: true, pending }, 202);
});

/**
 * Queue delivery target. Enriches one bounded slice of a run, then chains the
 * next slice.
 *
 * Redelivery safety comes from two places: `idempotencyKey` stops the chain from
 * forking, and the enrichment cache means a lead re-processed after a lost ack
 * resolves from cache at zero credits rather than being bought twice.
 *
 * Declared with app.post rather than app.openapi deliberately — it is a
 * machine-to-machine callback, not part of the app's public API surface, and
 * publishing it in discovery would just invite the managing agent to call it.
 *
 * It IS listed in `clawnify.json` under `app.api.public_routes`, and must be:
 * the queue delivers from outside the platform perimeter, which 403s every
 * unauthenticated request. Without that entry the job never arrives, every run
 * sits in `enriching` forever, and nothing anywhere reports an error — the
 * enqueue succeeded, so the app has no idea delivery failed. "Public" here means
 * reachable, not unauthenticated: verifyDelivery below rejects anything without
 * a valid queue signature, which is the only reason exposing it is safe.
 */
app.post("/api/jobs/enrich", async (c) => {
  const rawBody = await c.req.text();
  const ok = await verifyDelivery(rawBody, {
    signature: c.req.header("X-Queue-Signature") ?? null,
    timestamp: c.req.header("X-Queue-Timestamp") ?? null,
    keyId: c.req.header("X-Queue-Key-Id") ?? null,
  });
  if (!ok) return c.json({ error: "Invalid delivery signature" }, 401);

  let payload: { runId?: string; batch?: number; attempt?: string };
  try {
    payload = JSON.parse(rawBody) as { runId?: string; batch?: number; attempt?: string };
  } catch {
    return c.json({ error: "Malformed payload" }, 400);
  }
  const runId = payload.runId;
  const batch = Number(payload.batch ?? 0);
  // Carried from the enqueue so every batch in one attempt shares a namespace,
  // and a later retry of the whole run can't collide with this attempt's chain.
  const attempt = String(payload.attempt ?? "0");
  if (!runId) return c.json({ error: "Missing runId" }, 400);

  const opts = await enrichOptions(c);
  const leads = await query<Record<string, unknown>>(
    "SELECT * FROM leads WHERE run_id = ? AND enrich_status = 'pending' ORDER BY id LIMIT ?",
    [runId, BATCH_SIZE],
  );

  if (leads.length === 0) {
    // Nothing left to start. Leads parked on a callback keep the run open;
    // the callback (or its timeout sweep) that settles the last of them marks
    // the run done. Overdue pauses are expired here too, as a backstop for a
    // deployment whose queue could not schedule their sweeps.
    await expireOverdue(c.env as EnrichEnv, opts, { runId });
    await finishRunIfDrained(runId);
    const waiting = await get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM leads WHERE run_id = ? AND enrich_status = 'waiting'",
      [runId],
    );
    await run("UPDATE runs SET updated_at = datetime('now') WHERE id = ?", [runId]);
    return c.json({ ok: true, done: (waiting?.n ?? 0) === 0, waiting: waiting?.n ?? 0 }, 200);
  }

  for (const lead of leads) {
    await run("UPDATE leads SET enrich_status = 'running', updated_at = datetime('now') WHERE id = ?", [String(lead.id)]);
    await enrichLead(lead, c.env as EnrichEnv, opts);
  }

  // Heartbeat. A large run is many batches, none of which otherwise touch the
  // run row — without this the staleness clock would fire mid-enrichment and
  // report a healthy job as dead.
  await run("UPDATE runs SET updated_at = datetime('now') WHERE id = ?", [runId]);

  // Chain the next slice. A distinct key per batch keeps redelivery of *this*
  // job from spawning duplicate successors.
  try {
    await enqueueJob(c.env, {
      targetUrl: `${new URL(c.req.url).origin}/api/jobs/enrich`,
      payload: { runId, batch: batch + 1, attempt },
      idempotencyKey: `enrich:${runId}:${attempt}:${batch + 1}`,
      maxAttempts: 3,
    });
  } catch (err) {
    await run("UPDATE runs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?", [
      `Could not queue next batch: ${(err as Error).message}`,
      runId,
    ]);
    return c.json({ error: "Failed to chain next batch" }, 500);
  }

  return c.json({ ok: true, processed: leads.length }, 200);
});

const reEnrichLead = createRoute({
  method: "post",
  path: "/api/leads/{id}/enrich",
  tags: ["Enrichment"],
  summary: "Run the waterfall for a single lead",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      refresh: z.string().optional().openapi({
        description: "'true' to bypass the cache and re-buy from the vendors. Costs credits even for a lead we already resolved — only use it when you believe the cached value is wrong.",
      }),
    }),
  },
  responses: {
    200: { description: "Enriched", content: { "application/json": { schema: z.object({ lead: LeadSchema, credits_used: z.number().int(), cached: z.boolean() }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(reEnrichLead, async (c) => {
  const id = c.req.valid("param").id;
  const lead = await get<Record<string, unknown>>("SELECT * FROM leads WHERE id = ?", [id]);
  if (!lead) return c.json({ error: "Not found" }, 404);

  // Default to using the cache. Bypassing it is a deliberate "I think this value
  // is wrong" action, not the normal path — otherwise every click re-buys a
  // contact we already own.
  const refresh = c.req.valid("query").refresh === "true";

  // A lead still parked on a callback is re-run from scratch; its old pause is
  // dropped first so a late answer to it cannot land on top of this pass.
  await cancelPending(id);
  await run("UPDATE leads SET enrich_status = 'running', updated_at = datetime('now') WHERE id = ?", [id]);
  const outcome = await enrichLead({ ...lead, enrich_status: "running" }, c.env as EnrichEnv, await enrichOptions(c, refresh));

  // Non-null: the row was read and updated above in the same request.
  const updated = (await get<LeadRow>("SELECT * FROM leads WHERE id = ?", [id]))!;
  return c.json({ lead: updated, credits_used: outcome.credits, cached: outcome.cached }, 200);
});

/**
 * Where deferred vendors deliver their answer. The token is the whole
 * credential: a v4 UUID minted per pause, resolvable only while the pause is
 * open, and never listed anywhere. An unknown token is a 404 whether it is
 * late, duplicate, or forged — the three are indistinguishable and all
 * harmless, because nothing is written for them.
 *
 * Machine-to-machine, so app.post rather than app.openapi, and listed under
 * `public_routes` in clawnify.json for the same reason the queue target is:
 * the vendor calls from outside the platform perimeter.
 */
app.post("/api/callbacks/:token", async (c) => {
  const token = c.req.param("token");
  if (!/^[0-9a-f-]{36}$/i.test(token)) return c.json({ error: "Unknown callback" }, 404);
  const pending = await get<{ provider_id: string; field: string }>(
    "SELECT provider_id, field FROM pending_enrichments WHERE id = ?",
    [token],
  );
  if (!pending || !isField(pending.field)) return c.json({ error: "Unknown callback" }, 404);

  const provider = providerById(pending.provider_id);
  let answer: EnrichResult;
  if (!provider?.parseCallback) {
    answer = { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: `${pending.provider_id} is no longer a deferred provider` };
  } else {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    // Vendor payloads are data, never instructions: the adapter maps them onto
    // an EnrichResult and nothing else about the request is trusted.
    answer = provider.parseCallback(pending.field, body);
  }

  await resumeLead(token, answer, c.env as EnrichEnv, await enrichOptions(c));
  return c.json({ ok: true }, 200);
});

/**
 * Timeout for one pause, delivered by the queue CALLBACK_TIMEOUT_MINUTES after
 * it opened. A pause already settled by its callback is gone by then, and the
 * sweep finds nothing to do.
 */
app.post("/api/jobs/sweep-pending", async (c) => {
  const rawBody = await c.req.text();
  const ok = await verifyDelivery(rawBody, {
    signature: c.req.header("X-Queue-Signature") ?? null,
    timestamp: c.req.header("X-Queue-Timestamp") ?? null,
    keyId: c.req.header("X-Queue-Key-Id") ?? null,
  });
  if (!ok) return c.json({ error: "Invalid delivery signature" }, 401);

  let token: string | undefined;
  try {
    token = (JSON.parse(rawBody) as { token?: string }).token;
  } catch {
    return c.json({ error: "Malformed payload" }, 400);
  }
  if (!token) return c.json({ error: "Missing token" }, 400);

  const expired = await expireOverdue(c.env as EnrichEnv, await enrichOptions(c), { token });
  return c.json({ ok: true, expired }, 200);
});

// ── Export & push ───────────────────────────────────────────────────

/**
 * Rows per export call. Bounded like every other endpoint — an unbounded CSV is
 * the same context bomb as an unbounded JSON list, just harder to spot. Larger
 * exports page with `offset`.
 */
const EXPORT_MAX = 1000;

const exportCsv = createRoute({
  method: "get",
  // Namespaced under /api/export so it cannot be shadowed by /api/leads/{id},
  // which matched "export.csv" as an id. Structural fix, not route ordering.
  path: "/api/export/leads.csv",
  tags: ["Export"],
  summary: "Download leads as CSV (bounded; page with offset)",
  request: {
    query: z.object({
      run_id: z.string().optional(),
      only_with_email: z.string().optional().openapi({ description: "'true' to skip leads with no resolved email" }),
      format: z.enum(["leads", "linkedin-contacts", "linkedin-companies"]).optional().openapi({
        description:
          "'leads' (default) is the full record. 'linkedin-contacts' and 'linkedin-companies' emit the exact header rows LinkedIn Campaign Manager expects for a Matched Audiences list upload — contacts are matched on email, companies on name/website/email domain and are deduplicated across the whole result, not just this page.",
      }),
      limit: z.string().optional().openapi({ description: `Rows per call (default ${EXPORT_MAX}, max ${EXPORT_MAX})` }),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "CSV file", content: { "text/csv": { schema: z.string() } } },
  },
});

app.openapi(exportCsv, async (c) => {
  const q = c.req.valid("query");
  const format = q.format ?? "leads";
  const limit = Math.min(EXPORT_MAX, Math.max(1, parseInt(q.limit || String(EXPORT_MAX), 10) || EXPORT_MAX));
  const offset = Math.max(0, parseInt(q.offset || "0", 10) || 0);

  const where: string[] = [];
  const params: unknown[] = [];
  if (q.run_id) {
    where.push("run_id = ?");
    params.push(q.run_id);
  }
  // A LinkedIn contact list is matched on email alone, so a row without one is
  // not a weak match but no match — filter it in SQL rather than emitting the
  // row and dropping it after it has already consumed a page slot.
  if (q.only_with_email === "true" || format === "linkedin-contacts") where.push("email != ''");
  const whereSQL = where.length ? " WHERE " + where.join(" AND ") : "";

  let rows: Record<string, unknown>[];
  if (format === "linkedin-companies") {
    // Grouped in SQL, not in JS, so the deduplication holds across pages. Doing
    // it after LIMIT would emit the same account once per page it appears on.
    rows = await query<Record<string, unknown>>(
      `SELECT company, domain, MIN(location) AS location
         FROM leads${whereSQL}
        GROUP BY CASE WHEN domain != '' THEN lower(replace(domain, 'www.', '')) ELSE lower(company) END
        HAVING company != '' OR domain != ''
        ORDER BY company, domain
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
  } else {
    rows = await query<Record<string, unknown>>(
      `SELECT ${EXPORT_COLUMNS.join(", ")} FROM leads${whereSQL} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
  }

  const columns = columnsFor(format);
  return c.body(toCsv(toExportRows(format, rows), columns), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${format}-${offset}.csv"`,
  });
});

const pushLeads = createRoute({
  method: "post",
  path: "/api/export/push",
  tags: ["Export"],
  summary: "POST enriched leads to a CRM, sequencer, or webhook you control",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().openapi({ description: "https destination. Must be publicly routable." }),
            headers: z.record(z.string(), z.string()).optional().openapi({ description: "Extra headers, e.g. an Authorization bearer" }),
            run_id: z.string().optional(),
            only_with_email: z.boolean().optional().openapi({ description: "Default true — unresolved leads are rarely worth pushing" }),
            limit: z.number().int().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Pushed", content: { "application/json": { schema: z.object({ pushed: z.number().int(), status: z.number().int() }) } } },
    400: { description: "Rejected destination or nothing to push", content: { "application/json": { schema: ErrorSchema } } },
    502: { description: "Destination rejected the payload", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(pushLeads, async (c) => {
  const body = c.req.valid("json");
  const dest = checkDestination(body.url);
  if (!dest.ok) return c.json({ error: dest.reason }, 400);

  const limit = Math.min(EXPORT_MAX, Math.max(1, body.limit ?? EXPORT_MAX));
  const where: string[] = [];
  const params: unknown[] = [];
  if (body.run_id) {
    where.push("run_id = ?");
    params.push(body.run_id);
  }
  if (body.only_with_email !== false) where.push("email != ''");
  const whereSQL = where.length ? " WHERE " + where.join(" AND ") : "";

  const leads = await query<LeadRow>(
    `SELECT * FROM leads${whereSQL} ORDER BY created_at DESC, id LIMIT ?`,
    [...params, limit],
  );
  if (leads.length === 0) return c.json({ error: "No leads matched — nothing pushed" }, 400);

  let res: Response;
  try {
    res = await fetch(dest.url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...safeHeaders(body.headers) },
      body: JSON.stringify({ leads }),
      // "manual", not "error": the Workers runtime does not implement "error".
      // We then reject 3xx ourselves — following a redirect would let a
      // permitted host bounce the payload to one checkDestination rejected.
      redirect: "manual",
    });
  } catch (err) {
    return c.json({ error: `Could not reach destination: ${(err as Error).message}` }, 502);
  }
  const verdict = pushVerdict(res.status);
  if (!verdict.ok) return c.json({ error: verdict.error! }, 502);

  return c.json({ pushed: leads.length, status: res.status }, 200);
});

const healthz = createRoute({
  method: "get",
  path: "/api/health",
  tags: ["System"],
  summary: "Liveness plus whether the app can actually do its job",
  responses: {
    200: {
      description: "Health",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            configured_providers: z.number().int(),
            queue_available: z.boolean(),
          }),
        },
      },
    },
  },
});

app.openapi(healthz, async (c) => {
  const env = c.env as unknown as Record<string, unknown>;
  const configured = REGISTRY.filter((p) => {
    const v = env[p.secretName];
    return typeof v === "string" && v.length > 0;
  }).length;
  return c.json(
    { ok: true, configured_providers: configured, queue_available: Boolean(c.env.CLAWNIFY_TOKEN) },
    200,
  );
});

export default app;
export { OkSchema };
