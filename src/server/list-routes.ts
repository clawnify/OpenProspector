// Lists over HTTP. The behaviour is in lists.ts.
//
// What other apps rely on is on the OpenAPI surface: reading lists and their
// people, and registering as a reader with how many people a day it takes
// (an outreach campaign does this; the list's lookups follow it). Adding
// people by hand is there too.
//
// Creating a list, its cadence, attaching sources and Refresh now are control
// routes, plain and unpublished like the run dispatch and the monitor
// controls: a list's searches are handed to the agent, and an agent that
// learns these routes from discovery could hand work to itself on a schedule.
// People and agents can still call them; a sibling app (caller "app") cannot.

import { caller, createApp, createRoute, z } from "@clawnify/app";
import { verifyDelivery } from "@clawnify/queue";
import { get, query, run } from "./db.js";
import { LeadSchema } from "./lead-schema.js";
import { RUN_SELECT, STALE_AFTER, STRANDED_AFTER } from "./runs.js";
import { searchCompanies, unsearchedCompanies } from "./company-search.js";
import { MonitorInput } from "../shared/monitors.js";
import { INBOX_PARTS, inboxSql } from "../shared/inbox.js";
import {
  REFRESH,
  addMembers,
  afterJoin,
  backfill,
  bookTick,
  rearmIfOverdue,
  effectiveCap,
  latestRefresh,
  lookUpEmails,
  lookupsToday,
  nextRefresh,
  refreshHold,
  refreshList,
  tick,
  type ListRow,
  type ListsEnv,
} from "./lists.js";

type Env = { Bindings: ListsEnv };

class InputError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message);
  }
}

export const listRoutes = createApp<Env>({ db: false, discovery: false });
listRoutes.onError((e, c) => {
  if (e instanceof z.ZodError) return c.json({ error: e.issues.map((i) => i.message).join(" ") }, 400);
  if (e instanceof InputError) return c.json({ error: e.message }, e.status);
  console.error("List request failed", e);
  return c.json({ error: "List request failed. Refresh to check its state before retrying." }, 500);
});

const origin = (c: { req: { url: string } }) => new URL(c.req.url).origin;

/** Changing a list is for people and agents. A sibling app reads lists and says what it takes. */
function notForApps(c: Parameters<typeof caller>[0]): void {
  if (caller(c) === "app") {
    throw new InputError("An app can read lists and register what it takes a day; changing a list is for people and agents.", 403);
  }
}

const ListId = z.string().uuid();
const Page = z.object({
  page: z.string().optional().openapi({ description: "Page number (default: 1)" }),
  limit: z.string().optional().openapi({ description: "Items per page (default: 25, max: 100)" }),
});

function paging(q: { page?: string; limit?: string }) {
  const page = Math.max(1, parseInt(q.page || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit || "25", 10) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

// ── Shapes ──────────────────────────────────────────────────────────

const ListSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    refresh: z.enum(REFRESH).openapi({ description: "How often its searches run again. Signals keep their own schedule." }),
    member_count: z.number().int(),
    verified_count: z.number().int().openapi({ description: "People in the list with a verified email" }),
    email_daily_cap: z.number().int().nullable().openapi({ description: "Automatic email lookups per UTC day. Null: what its readers take a day." }),
    effective_daily_cap: z.number().int().openapi({ description: "The cap in force: email_daily_cap, else the sum of its readers' daily numbers, else 0 (no automatic lookups)" }),
    lookups_today: z.number().int().openapi({ description: "Automatic lookups started this UTC day" }),
    last_refreshed_at: z.string().nullable(),
    next_refresh_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("List");

const MemberSchema = LeadSchema.extend({
  added_at: z.string(),
  source_kind: z.enum(["search", "signal", "manual"]),
  source_id: z.string().openapi({ description: "The search (run id) or signal (monitor id) that added them; empty when added by hand" }),
  email_kind: z.enum(["person", "inbox"]).nullable().openapi({
    description: "inbox: a company's public address (info@, contact@), not a person's: write to it as to the company, with no first name. Null without an email.",
  }),
}).openapi("ListMember");

const ConsumerSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    daily: z.number().int(),
    updated_at: z.string(),
  })
  .openapi("ListConsumer");

const SourceSchema = z
  .object({
    kind: z.enum(["search", "signal"]),
    source_id: z.string(),
    name: z.string(),
    added_at: z.string(),
    missing: z.boolean().openapi({ description: "The search or signal no longer exists" }),
    // A search: its latest re-run and whether the schedule holds it.
    last_refresh: z
      .object({ id: z.string(), status: z.string(), error: z.string(), lead_count: z.number().int(), created_at: z.string(), stale: z.number().int() })
      .nullable()
      .optional(),
    hold: z.enum(["working", "failed", "stalled", "undelivered"]).nullable().optional(),
    // A signal: its own schedule.
    frequency: z.string().nullable().optional(),
    active: z.boolean().nullable().optional(),
    schedule_error: z.string().nullable().optional(),
  })
  .openapi("ListSource");

interface SummaryRow extends ListRow {
  member_count: number;
  verified_count: number;
  consumer_daily: number | null;
}

const SUMMARY_SELECT = `l.*,
  (SELECT COUNT(*) FROM list_members m WHERE m.list_id = l.id) AS member_count,
  (SELECT COUNT(*) FROM list_members m JOIN leads d ON d.id = m.lead_id WHERE m.list_id = l.id AND d.email_verified = 1) AS verified_count,
  (SELECT SUM(daily) FROM list_consumers k WHERE k.list_id = l.id) AS consumer_daily`;

function summary(r: SummaryRow, now = new Date()) {
  const fromConsumers = r.consumer_daily && r.consumer_daily > 0 ? r.consumer_daily : 0;
  return {
    id: r.id,
    name: r.name,
    refresh: r.refresh,
    member_count: r.member_count,
    verified_count: r.verified_count,
    email_daily_cap: r.email_daily_cap,
    effective_daily_cap: r.email_daily_cap ?? fromConsumers,
    lookups_today: lookupsToday(r, now),
    last_refreshed_at: r.last_refreshed_at,
    next_refresh_at: r.next_refresh_at,
    created_at: r.created_at,
  };
}

async function readList(id: string) {
  const row = await get<SummaryRow>(`SELECT ${SUMMARY_SELECT} FROM lists l WHERE l.id = ?`, [ListId.parse(id)]);
  if (!row) throw new InputError("List not found", 404);
  return row;
}

async function sourcesOf(listId: string) {
  const rows = await query<{ kind: "search" | "signal"; source_id: string; added_at: string }>(
    "SELECT kind, source_id, added_at FROM list_sources WHERE list_id = ? ORDER BY added_at, source_id",
    [listId],
  );
  const out: z.infer<typeof SourceSchema>[] = [];
  for (const s of rows) {
    if (s.kind === "search") {
      const search = await get<{ icp_prompt: string; source: string }>(`SELECT ${RUN_SELECT} FROM runs WHERE id = ?`, [STALE_AFTER, s.source_id]);
      const last = await latestRefresh(s.source_id);
      out.push({
        ...s,
        name: search ? search.icp_prompt : "Deleted search",
        missing: !search,
        last_refresh: last
          ? { id: last.id, status: last.status, error: last.error, lead_count: last.lead_count, created_at: last.created_at, stale: last.stale }
          : null,
        hold: refreshHold(last),
      });
    } else {
      const monitor = await get<{ config: string; active: number; schedule_error: string | null }>(
        "SELECT config, active, schedule_error FROM signal_monitors WHERE id = ?",
        [s.source_id],
      );
      let name = "Deleted signal";
      let frequency: string | null = null;
      if (monitor) {
        try {
          const cfg = JSON.parse(monitor.config) as { name?: string; frequency?: string };
          name = cfg.name || "Signal";
          frequency = cfg.frequency ?? null;
        } catch {
          name = "Signal";
        }
      }
      out.push({
        ...s,
        name,
        missing: !monitor,
        frequency,
        active: monitor ? Boolean(monitor.active) : null,
        schedule_error: monitor?.schedule_error ?? null,
      });
    }
  }
  return out;
}

async function consumersOf(listId: string) {
  return query<{ key: string; name: string; daily: number; updated_at: string }>(
    "SELECT consumer_key AS key, name, daily, updated_at FROM list_consumers WHERE list_id = ? ORDER BY name, consumer_key",
    [listId],
  );
}

// ── Reading (the contract other apps use) ───────────────────────────

listRoutes.openapi(
  createRoute({
    method: "get",
    path: "/api/lists",
    tags: ["Lists"],
    summary: "Lists of people that keep filling from searches and signals",
    request: { query: Page },
    responses: {
      200: {
        description: "A page of lists",
        content: {
          "application/json": {
            schema: z.object({ lists: z.array(ListSchema), total: z.number().int(), page: z.number().int(), limit: z.number().int() }),
          },
        },
      },
    },
  }),
  async (c) => {
    const { page, limit, offset } = paging(c.req.valid("query"));
    const rows = await query<SummaryRow>(`SELECT ${SUMMARY_SELECT} FROM lists l ORDER BY l.created_at DESC, l.id LIMIT ? OFFSET ?`, [limit, offset]);
    for (const r of rows) await rearmIfOverdue(c.env, origin(c), r);
    const total = await get<{ n: number }>("SELECT COUNT(*) AS n FROM lists");
    return c.json({ lists: rows.map((r) => summary(r)), total: total?.n ?? 0, page, limit }, 200);
  },
);

listRoutes.openapi(
  createRoute({
    method: "get",
    path: "/api/lists/{id}",
    tags: ["Lists"],
    summary: "One list: its sources, its readers and what they take a day",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: "The list",
        content: {
          "application/json": {
            schema: z.object({
              list: ListSchema,
              cap_from: z.enum(["list", "consumers", "none"]).openapi({ description: "Where effective_daily_cap comes from" }),
              sources: z.array(SourceSchema),
              consumers: z.array(ConsumerSchema),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const row = await readList(c.req.param("id"));
    await rearmIfOverdue(c.env, origin(c), row);
    const { from } = await effectiveCap(row.id);
    return c.json({ list: summary(row), cap_from: from, sources: await sourcesOf(row.id), consumers: await consumersOf(row.id) }, 200);
  },
);

listRoutes.openapi(
  createRoute({
    method: "get",
    path: "/api/lists/{id}/members",
    tags: ["Lists"],
    summary: "The people in a list, oldest first, so a reader can page through new ones steadily",
    request: {
      params: z.object({ id: z.string() }),
      query: Page.extend({
        email_verified: z.string().optional().openapi({ description: "'true' for people with a verified email only" }),
        email_kind: z.enum(["person", "inbox"]).optional().openapi({
          description: "person: a named person's address. inbox: a company's public address (info@, contact@), with no name. Leave out for both.",
        }),
      }),
    },
    responses: {
      200: {
        description: "A page of people, ordered by when they joined, then by lead id",
        content: {
          "application/json": {
            schema: z.object({ members: z.array(MemberSchema), total: z.number().int(), page: z.number().int(), limit: z.number().int() }),
          },
        },
      },
    },
  }),
  async (c) => {
    const list = await readList(c.req.param("id"));
    await rearmIfOverdue(c.env, origin(c), list);
    const q = c.req.valid("query");
    const { page, limit, offset } = paging(q);
    const verified = q.email_verified === "true" ? " AND d.email_verified = 1" : "";
    const kind = q.email_kind ? ` AND d.email != '' AND ${q.email_kind === "inbox" ? "" : "NOT "}${inboxSql("d.email")}` : "";
    const kindParams = q.email_kind ? INBOX_PARTS : [];
    const rows = await query<z.infer<typeof MemberSchema>>(
      `SELECT d.*, (CASE WHEN d.enrich_status = 'running' AND d.updated_at < datetime('now', ?) THEN 1 ELSE 0 END) AS stale,
              (CASE WHEN COALESCE(d.email, '') = '' THEN NULL WHEN ${inboxSql("d.email")} THEN 'inbox' ELSE 'person' END) AS email_kind,
              m.added_at, m.source_kind, m.source_id
         FROM list_members m JOIN leads d ON d.id = m.lead_id
        WHERE m.list_id = ?${verified}${kind}
        ORDER BY m.added_at, m.lead_id LIMIT ? OFFSET ?`,
      [STRANDED_AFTER, ...INBOX_PARTS, list.id, ...kindParams, limit, offset],
    );
    const total = await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM list_members m JOIN leads d ON d.id = m.lead_id WHERE m.list_id = ?${verified}${kind}`,
      [list.id, ...kindParams],
    );
    return c.json({ members: rows, total: total?.n ?? 0, page, limit }, 200);
  },
);

const ConsumerKey = z.string().regex(/^[A-Za-z0-9:_-]{1,120}$/, "The key is 1 to 120 letters, digits, colons, underscores or hyphens");

listRoutes.openapi(
  createRoute({
    method: "put",
    path: "/api/lists/{id}/consumers/{key}",
    tags: ["Lists"],
    summary: "Register as a reader of a list, with how many people a day you take",
    description:
      "An outreach campaign reading the list says how many people it takes a day. With no cap of its own, the list looks up emails for that many new people a day (the sum over its readers). Idempotent: the same key updates.",
    request: {
      params: z.object({ id: z.string(), key: ConsumerKey }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ name: z.string().trim().min(1).max(120), daily: z.number().int().min(0).max(1000) }),
          },
        },
      },
    },
    responses: {
      200: { description: "The reader as stored", content: { "application/json": { schema: z.object({ consumer: ConsumerSchema }) } } },
    },
  }),
  async (c) => {
    const list = await readList(c.req.param("id"));
    const key = ConsumerKey.parse(c.req.param("key"));
    const body = c.req.valid("json");
    await run(
      `INSERT INTO list_consumers (list_id, consumer_key, name, daily, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT (list_id, consumer_key) DO UPDATE SET name = excluded.name, daily = excluded.daily, updated_at = excluded.updated_at`,
      [list.id, key, body.name, body.daily],
    );
    // More taken a day can mean more lookups today.
    await afterJoin(c.env, origin(c), [list.id]);
    const consumer = (await get<{ key: string; name: string; daily: number; updated_at: string }>(
      "SELECT consumer_key AS key, name, daily, updated_at FROM list_consumers WHERE list_id = ? AND consumer_key = ?",
      [list.id, key],
    ))!;
    return c.json({ consumer }, 200);
  },
);

listRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/api/lists/{id}/consumers/{key}",
    tags: ["Lists"],
    summary: "Stop reading a list",
    request: { params: z.object({ id: z.string(), key: ConsumerKey }) },
    responses: { 200: { description: "Removed (or was not there)", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
  }),
  async (c) => {
    const list = await readList(c.req.param("id"));
    await run("DELETE FROM list_consumers WHERE list_id = ? AND consumer_key = ?", [list.id, ConsumerKey.parse(c.req.param("key"))]);
    return c.json({ ok: true }, 200);
  },
);

listRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/lists/{id}/members",
    tags: ["Lists"],
    summary: "Add people to a list by hand",
    description: "Leads already in the list, or a second lead for someone already in it, are left out.",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: z.object({ lead_ids: z.array(z.string().min(1).max(200)).min(1).max(500) }) } } },
    },
    responses: { 200: { description: "How many joined", content: { "application/json": { schema: z.object({ added: z.number().int() }) } } } },
  }),
  async (c) => {
    notForApps(c);
    const list = await readList(c.req.param("id"));
    const added = await addMembers(list.id, c.req.valid("json").lead_ids, "manual", "");
    if (added > 0) await afterJoin(c.env, origin(c), [list.id]);
    return c.json({ added }, 200);
  },
);

// ── Control (unpublished: see the top of this file) ─────────────────

const ListInput = z.object({
  name: z.string().trim().min(1, "A list needs a name").max(120),
  refresh: z.enum(REFRESH).optional(),
  email_daily_cap: z.number().int().min(0).max(1000).nullable().optional(),
});

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new InputError("Invalid JSON");
  }
}

listRoutes.post("/api/lists", async (c) => {
  notForApps(c);
  const input = ListInput.parse(await body(c));
  const id = crypto.randomUUID();
  const refresh = input.refresh ?? "daily";
  const next = nextRefresh(refresh, new Date());
  await run("INSERT INTO lists (id, name, refresh, email_daily_cap, next_refresh_at) VALUES (?, ?, ?, ?, ?)", [
    id,
    input.name,
    refresh,
    input.email_daily_cap ?? null,
    next,
  ]);
  if (next) await bookTick(c.env, origin(c), id, new Date(next));
  return c.json({ list: summary(await readList(id)) }, 201);
});

listRoutes.patch("/api/lists/:id", async (c) => {
  notForApps(c);
  const list = await readList(c.req.param("id"));
  const patch = ListInput.partial().strict().parse(await body(c));
  if (patch.name !== undefined) await run("UPDATE lists SET name = ?, updated_at = datetime('now') WHERE id = ?", [patch.name, list.id]);
  if (patch.refresh !== undefined && patch.refresh !== list.refresh) {
    // A new cadence counts from now.
    const next = nextRefresh(patch.refresh, new Date());
    await run("UPDATE lists SET refresh = ?, next_refresh_at = ?, updated_at = datetime('now') WHERE id = ?", [patch.refresh, next, list.id]);
    if (next) await bookTick(c.env, origin(c), list.id, new Date(next));
  }
  if (patch.email_daily_cap !== undefined) {
    await run("UPDATE lists SET email_daily_cap = ?, updated_at = datetime('now') WHERE id = ?", [patch.email_daily_cap, list.id]);
    await afterJoin(c.env, origin(c), [list.id]);
  }
  return c.json({ list: summary(await readList(list.id)) }, 200);
});

listRoutes.delete("/api/lists/:id", async (c) => {
  notForApps(c);
  const list = await readList(c.req.param("id"));
  // The people stay in Leads; only the list goes. Explicit, rather than
  // trusting the foreign keys to cascade.
  for (const table of ["list_members", "list_sources", "list_consumers"]) {
    await run(`DELETE FROM ${table} WHERE list_id = ?`, [list.id]);
  }
  await run("DELETE FROM lists WHERE id = ?", [list.id]);
  return c.json({ ok: true });
});

const SourceInput = z.object({ kind: z.enum(["search", "signal"]), source_id: z.string().min(1).max(200) }).strict();

listRoutes.post("/api/lists/:id/sources", async (c) => {
  notForApps(c);
  const list = await readList(c.req.param("id"));
  const input = SourceInput.parse(await body(c));
  let sourceId = input.source_id;
  let signal: { config: string } | null = null;
  if (input.kind === "search") {
    const search = await get<{ id: string; refresh_of: string | null; company_domain: string | null }>(
      "SELECT id, refresh_of, company_domain FROM runs WHERE id = ?",
      [sourceId],
    );
    if (!search) throw new InputError("Search not found", 404);
    // Its people already reach the lists of the signals that found the company.
    if (search.company_domain) throw new InputError("This search was opened for one company a signal found. Add that signal instead.");
    // A re-run stands for the search it repeated.
    sourceId = search.refresh_of || search.id;
  } else {
    signal = (await get<{ config: string }>("SELECT config FROM signal_monitors WHERE id = ?", [sourceId])) ?? null;
    if (!signal) throw new InputError("Signal not found", 404);
  }
  await run("INSERT INTO list_sources (list_id, kind, source_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [list.id, input.kind, sourceId]);
  const added = await backfill(list.id, input.kind, sourceId);
  // A signal's companies nobody searched yet get a search now, newest first, as
  // many as one of its checks may record: attaching it is the review.
  let searching = 0;
  if (signal) {
    const cfg = MonitorInput.parse(JSON.parse(signal.config));
    const companies = await unsearchedCompanies(sourceId, cfg.max_per_check);
    searching = companies.length;
    if (companies.length) await searchCompanies(c.env, origin(c), { id: sourceId, name: cfg.name, who_to_contact: cfg.who_to_contact }, companies);
  }
  if (added > 0) await afterJoin(c.env, origin(c), [list.id]);
  return c.json({ source: { kind: input.kind, source_id: sourceId }, added, searching }, 201);
});

listRoutes.delete("/api/lists/:id/sources/:kind/:sourceId", async (c) => {
  notForApps(c);
  const list = await readList(c.req.param("id"));
  const kind = z.enum(["search", "signal"]).parse(c.req.param("kind"));
  // The people it already added stay in the list.
  await run("DELETE FROM list_sources WHERE list_id = ? AND kind = ? AND source_id = ?", [list.id, kind, c.req.param("sourceId")]);
  return c.json({ ok: true });
});

/** Refresh now: run the list's searches again at once, retrying any held by a failed or stalled re-run. */
listRoutes.post("/api/lists/:id/refresh", async (c) => {
  notForApps(c);
  const list = await readList(c.req.param("id"));
  const result = await refreshList(c.env, origin(c), list.id, new Date(), true);
  const lookups = await lookUpEmails(c.env, origin(c), list.id);
  return c.json({ started: result.started, failed: result.failed, lookups }, 202);
});

/**
 * Queue delivery target for a list's tick (lists.ts, tick): refresh when due,
 * then the lookups the cap allows. Machine-to-machine, so a plain route, and
 * listed under `public_routes` in clawnify.json like the other job targets:
 * the queue delivers from outside the platform perimeter, and verifyDelivery
 * is what makes exposing it safe.
 */
listRoutes.post("/api/jobs/list-tick", async (c) => {
  const raw = await c.req.text();
  const ok = await verifyDelivery(raw, {
    signature: c.req.header("X-Queue-Signature") ?? null,
    timestamp: c.req.header("X-Queue-Timestamp") ?? null,
    keyId: c.req.header("X-Queue-Key-Id") ?? null,
  });
  if (!ok) return c.json({ error: "Invalid delivery signature" }, 401);
  let payload: { listId?: string };
  try {
    payload = JSON.parse(raw) as { listId?: string };
  } catch {
    return c.json({ error: "Malformed payload" }, 400);
  }
  if (!payload.listId) return c.json({ error: "Missing listId" }, 400);
  const result = await tick(c.env, origin(c), payload.listId);
  return c.json({ ok: true, ...result }, 200);
});
