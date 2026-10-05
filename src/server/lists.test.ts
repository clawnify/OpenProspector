import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

let db: DatabaseSync;
vi.mock("./db.js", () => ({
  get: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).get(...values),
  query: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).all(...values),
  run: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).run(...values),
}));

// Every waterfall answers from here, so no vendor is called. Records the field
// each pass bought, which is how "emails only" is checked.
const bought: string[] = [];
vi.mock("./providers/index.js", async (original) => {
  const real = await original<typeof import("./providers/index.js")>();
  return {
    ...real,
    runWaterfall: async (field: string) => {
      bought.push(field);
      const value = field === "email" ? "ana@acme.example" : field === "phone" ? "+31 6 0000 0000" : null;
      return { field, value, verified: Boolean(value), providerId: value ? "findymail" : null, cached: false, totalCredits: 0, attempts: [] };
    },
  };
});

// The queue as it behaves for real: refuses without a token, and a repeated
// idempotency key hands back the job it already has.
const SIGNATURE = "test-signature";
type Job = { targetUrl: string; payload: any; runAt?: string; idempotencyKey?: string };
const jobs: Job[] = [];
vi.mock("@clawnify/queue", () => ({
  enqueueJob: async (env: { CLAWNIFY_TOKEN?: string }, opts: { targetUrl: string; payload?: unknown; runAt?: Date | string; idempotencyKey?: string }) => {
    if (!env.CLAWNIFY_TOKEN) throw new Error("CLAWNIFY_TOKEN is not set");
    const existing = opts.idempotencyKey ? jobs.find((j) => j.idempotencyKey === opts.idempotencyKey) : undefined;
    if (existing) return { id: "existing", status: "pending" };
    const runAt = opts.runAt instanceof Date ? opts.runAt.toISOString() : opts.runAt;
    jobs.push({ targetUrl: opts.targetUrl, payload: opts.payload, runAt, idempotencyKey: opts.idempotencyKey });
    return { id: `job-${jobs.length}`, status: "pending", run_at: runAt ?? new Date().toISOString() };
  },
  verifyDelivery: async (_raw: string, headers: { signature?: string | null }) => headers.signature === SIGNATURE,
}));

import app from "./index";

const DB = { prepare: () => { throw new Error("queries must go through the mocked ./db.js"); } };
const env = { CLAWNIFY_TOKEN: "test-only-token", DB };
const APP = { "X-Clawnify-Caller": "app" };
const AGENT = { "X-Clawnify-Caller": "agent" };

async function request(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await app.request(
    `https://prospector.example${path}`,
    {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    env,
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function ok(path: string, init: Parameters<typeof request>[1] = {}) {
  const r = await request(path, init);
  expect(r.status, `${init.method ?? "GET"} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

const deliver = (job: Job) =>
  request(new URL(job.targetUrl).pathname, { method: "POST", body: job.payload, headers: { "X-Queue-Signature": SIGNATURE } });

const jobsFor = (path: string) => jobs.filter((j) => new URL(j.targetUrl).pathname === path);
const row = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).get(...values) as Record<string, any>;
const rows = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).all(...values) as Record<string, any>[];

async function newList(body: Record<string, unknown> = {}) {
  return (await ok("/api/lists", { method: "POST", body: { name: "Dutch builders", ...body } })).list as Record<string, any>;
}
async function newSearch(prompt = "Building firms in the Netherlands, 20 to 200 staff") {
  return (await ok("/api/runs", { method: "POST", body: { icp_prompt: prompt } })).run as Record<string, any>;
}
const post = (runId: string, leads: Record<string, unknown>[]) => ok("/api/leads", { method: "POST", body: { run_id: runId, leads }, headers: AGENT });
const ana = { full_name: "Ana de Vries", company: "Bouw BV", domain: "bouw.nl", linkedin_url: "https://www.linkedin.com/in/ana-devries" };
const jan = { full_name: "Jan Smit", company: "Smit Bouw", domain: "smitbouw.nl" };
const eva = { full_name: "Eva Bakker", company: "Bakker Bouw", domain: "bakkerbouw.nl" };

// A signal monitor, created the way the Signals page does (frequency "once" makes no schedule).
const serverId = "46d3c39e-d490-433d-b27c-db7e2d6fd396";
const monitorConfig = {
  name: "Engaged with our posts", kind: "post", source: "https://www.linkedin.com/posts/test_activity-123",
  icp: "Building firm owners", server_id: serverId, frequency: "once", include_existing: true, ends_at: null,
};
const finding = {
  person_name: "Piet Jansen", profile_url: "https://www.linkedin.com/in/piet-jansen", post_url: monitorConfig.source,
  source_url: monitorConfig.source, engagement: "comment", quote: "We lose weeks to permits", occurred_at: null,
  why_fit: "Runs a building firm", outreach_context: "Commented on our permits post",
};
async function newMonitor(overrides: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  await ok("/api/monitors", { method: "POST", body: { id, ...monitorConfig, ...overrides } });
  return id;
}
async function beginCheck(monitorId: string) {
  return (await ok(`/api/monitors/${monitorId}/checks`, { method: "POST", body: { id: crypto.randomUUID() } })).check as Record<string, any>;
}

let agentCalls: string[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  jobs.length = 0;
  bought.length = 0;
  agentCalls = [];
  // The platform's agents API: a dispatch is accepted.
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    agentCalls.push(String(url));
    if (String(url).endsWith("/tasks")) return Response.json({ task_id: `task-${agentCalls.length}`, server_id: serverId, agent: "main", status: "queued" }, { status: 202 });
    return Response.json({ servers: [{ id: serverId, name: "Pedro", status: "ready" }], page: { limit: 25, offset: 0, has_more: false } });
  }));
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("the list contract", () => {
  it("the manifest says it provides leads where the platform reads it (app.provides)", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../clawnify.json", import.meta.url), "utf8"));
    expect(manifest.app.provides).toContain("leads");
    expect(manifest.provides).toBeUndefined();
  });

  it("lists carry the fields other apps read", async () => {
    const created = await newList({ refresh: "weekly" });
    const { lists, total, page, limit } = await ok("/api/lists");
    expect({ total, page, limit }).toEqual({ total: 1, page: 1, limit: 25 });
    expect(lists[0]).toMatchObject({
      id: created.id, name: "Dutch builders", refresh: "weekly", member_count: 0, verified_count: 0,
      email_daily_cap: null, effective_daily_cap: 0,
    });
    expect(typeof lists[0].created_at).toBe("string");
  });

  it("a sibling app reads lists and registers what it takes, and changes nothing else", async () => {
    const list = await newList();
    expect((await request("/api/lists", { headers: APP })).status).toBe(200);
    expect((await request(`/api/lists/${list.id}/members?email_verified=true`, { headers: APP })).status).toBe(200);
    const put = await request(`/api/lists/${list.id}/consumers/opensequence:campaign-1`, { method: "PUT", body: { name: "Builders NL", daily: 10 }, headers: APP });
    expect(put.status).toBe(200);
    expect(put.body.consumer).toMatchObject({ key: "opensequence:campaign-1", name: "Builders NL", daily: 10 });
    expect((await request(`/api/lists/${list.id}/consumers/opensequence:campaign-1`, { method: "DELETE", headers: APP })).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", "/api/lists", { name: "x" }],
      ["PATCH", `/api/lists/${list.id}`, { name: "x" }],
      ["DELETE", `/api/lists/${list.id}`, undefined],
      ["POST", `/api/lists/${list.id}/members`, { lead_ids: ["a"] }],
      ["POST", `/api/lists/${list.id}/sources`, { kind: "search", source_id: "a" }],
      ["POST", `/api/lists/${list.id}/refresh`, undefined],
    ] as const) {
      expect((await request(path, { method, body, headers: APP })).status, `${method} ${path}`).toBe(403);
    }
  });

  it("refuses a malformed reader key, and a reader's number outside 0 to 1000", async () => {
    const list = await newList();
    expect((await request(`/api/lists/${list.id}/consumers/has%20space`, { method: "PUT", body: { name: "x", daily: 1 } })).status).toBe(400);
    expect((await request(`/api/lists/${list.id}/consumers/ok`, { method: "PUT", body: { name: "x", daily: 1001 } })).status).toBe(400);
  });

  it("members come oldest first, then by lead id, and can be limited to verified emails", async () => {
    const list = await newList();
    const search = await newSearch();
    await ok(`/api/lists/${list.id}/sources`, { method: "POST", body: { kind: "search", source_id: search.id } });
    await post(search.id, [ana, jan, eva]);
    db.prepare("UPDATE leads SET email = 'jan@smitbouw.nl', email_verified = 1 WHERE full_name = 'Jan Smit'").run();
    const all = await ok(`/api/lists/${list.id}/members?limit=2`);
    expect(all.total).toBe(3);
    const ordered = rows("SELECT lead_id FROM list_members WHERE list_id = ? ORDER BY added_at, lead_id", list.id).map((r) => r.lead_id);
    expect(all.members.map((m: any) => m.id)).toEqual(ordered.slice(0, 2));
    expect(all.members[0]).toMatchObject({ source_kind: "search", source_id: search.id });
    const verified = await ok(`/api/lists/${list.id}/members?email_verified=true`);
    expect(verified.members.map((m: any) => m.full_name)).toEqual(["Jan Smit"]);
    expect((await ok("/api/lists")).lists[0]).toMatchObject({ member_count: 3, verified_count: 1 });
  });
});

describe("people join from a search", () => {
  it("leads posted to a search feeding the list join it, once per person", async () => {
    const list = await newList();
    const search = await newSearch();
    await ok(`/api/lists/${list.id}/sources`, { method: "POST", body: { kind: "search", source_id: search.id } });
    await post(search.id, [ana, jan]);
    // The same people again, as a re-run would find them: same profile, or same name at the same domain.
    await post(search.id, [{ ...ana, full_name: "Ana De Vries" }, { full_name: "JAN SMIT", domain: "smitbouw.nl" }]);
    expect(row("SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?", list.id).n).toBe(2);
    expect(row("SELECT COUNT(*) AS n FROM leads").n).toBe(4);
  });

  it("attaching a search brings the people it already found", async () => {
    const list = await newList();
    const search = await newSearch();
    await post(search.id, [ana, jan]);
    const r = await ok(`/api/lists/${list.id}/sources`, { method: "POST", body: { kind: "search", source_id: search.id } });
    expect(r.added).toBe(2);
  });

  it("a re-run stands for the search it repeated", async () => {
    const list = await newList();
    const search = await newSearch();
    const rerun = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id, icp_prompt, refresh_of) VALUES (?, 'x', ?)").run(rerun, search.id);
    const r = await ok(`/api/lists/${list.id}/sources`, { method: "POST", body: { kind: "search", source_id: rerun } });
    expect(r.source.source_id).toBe(search.id);
  });

  it("people added by hand join too, never twice", async () => {
    const list = await newList();
    const search = await newSearch();
    await post(search.id, [ana, jan]);
    const ids = rows("SELECT id FROM leads ORDER BY full_name").map((r) => r.id);
    expect((await ok(`/api/lists/${list.id}/members`, { method: "POST", body: { lead_ids: ids } })).added).toBe(2);
    expect((await ok(`/api/lists/${list.id}/members`, { method: "POST", body: { lead_ids: ids } })).added).toBe(0);
  });
});

describe("people join from a signal", () => {
  it("each new person a signal feeding the list finds becomes a lead in it, without the review", async () => {
    const list = await newList();
    const monitor = await newMonitor();
    await ok(`/api/lists/${list.id}/sources`, { method: "POST", body: { kind: "signal", source_id: monitor } });
    const check = await beginCheck(monitor);
    await ok(`/api/monitor-checks/${check.id}/observations`, { method: "POST", body: { observations: [finding] }, headers: AGENT });
    const members = await ok(`/api/lists/${list.id}/members`);
    expect(members.members).toHaveLength(1);
    // The profile is stored normalized, as "Add to people" stores it.
    expect(members.members[0]).toMatchObject({ full_name: "Piet Jansen", linkedin_url: "https://linkedin.com/in/piet-jansen", source_kind: "signal", source_id: monitor });
    // The finding is linked to the lead, as "Add to people" would have done.
    expect(row("SELECT lead_id FROM signal_observations").lead_id).toBe(members.members[0].id);
  });

  it("a signal that feeds no list still waits for review", async () => {
    const monitor = await newMonitor();
    const check = await beginCheck(monitor);
    await ok(`/api/monitor-checks/${check.id}/observations`, { method: "POST", body: { observations: [finding] }, headers: AGENT });
    expect(row("SELECT COUNT(*) AS n FROM leads").n).toBe(0);
  });

  it("company findings and a hidden first-run baseline never join", async () => {
    const list = await newList();
    const custom = await newMonitor({ kind: "custom", source: "Find coverage of Dutch building firms.", icp: "", name: "Coverage" });
    await ok(`/api/lists/${list.id}/sources`, { method: "POST", body: { kind: "signal", source_id: custom } });
    const company = {
      kind: "custom", subject: { type: "company", name: "Bouw BV", domain: "bouw.nl" }, source_url: "https://magazine.example/bouw",
      summary: "Covered for a new site.", reason: "Recent coverage.", occurred_at: null,
    };
    const check = await beginCheck(custom);
    await ok(`/api/monitor-checks/${check.id}/observations`, { method: "POST", body: { observations: [company] }, headers: AGENT });
    expect(row("SELECT COUNT(*) AS n FROM list_members").n).toBe(0);

    const baselined = await newMonitor({ include_existing: false });
    await ok(`/api/lists/${list.id}/sources`, { method: "POST", body: { kind: "signal", source_id: baselined } });
    const first = await beginCheck(baselined);
    expect(first.baseline).toBe(1);
    await ok(`/api/monitor-checks/${first.id}/observations`, { method: "POST", body: { observations: [finding] }, headers: AGENT });
    expect(row("SELECT COUNT(*) AS n FROM list_members").n).toBe(0);
  });

  it("someone added to People by hand from a signal that feeds the list joins it", async () => {
    const monitor = await newMonitor();
    const check = await beginCheck(monitor);
    await ok(`/api/monitor-checks/${check.id}/observations`, { method: "POST", body: { observations: [finding] }, headers: AGENT });
    const list = await newList();
    await ok(`/api/lists/${list.id}/sources`, { method: "POST", body: { kind: "signal", source_id: monitor } });
    // Found before the signal fed the list: still waiting for review, so not in it.
    expect(row("SELECT COUNT(*) AS n FROM list_members").n).toBe(0);
    const observation = row("SELECT id FROM signal_observations").id;
    await ok(`/api/monitor-observations/${observation}/lead`, { method: "POST" });
    expect(row("SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?", list.id).n).toBe(1);
  });
});

describe("refresh", () => {
  it("books the list's next refresh on the queue, one interval out", async () => {
    const before = Date.now();
    const list = await newList({ refresh: "hourly" });
    const tick = jobsFor("/api/jobs/list-tick");
    expect(tick).toHaveLength(1);
    expect(tick[0].payload).toEqual({ listId: list.id });
    const at = Date.parse(tick[0].runAt!);
    expect(at - before).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
    expect(at - before).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);
    expect(list.next_refresh_at).toBe(tick[0].runAt);
    // Off books nothing.
    jobs.length = 0;
    await newList({ refresh: "off" });
    expect(jobsFor("/api/jobs/list-tick")).toHaveLength(0);
  });

  it("a due tick runs each search again, to the agent, and its leads join the list", async () => {
    const list = await newList({ refresh: "daily" });
    const search = await newSearch();
    await ok(`/api/lists/${list.id}/sources`, { method: "POST", body: { kind: "search", source_id: search.id } });
    db.prepare("UPDATE lists SET next_refresh_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(list.id);
    const r = await deliver(jobsFor("/api/jobs/list-tick")[0]);
    expect(r.body).toMatchObject({ ok: true, refreshed: true });
    const rerun = row("SELECT * FROM runs WHERE refresh_of = ?", search.id);
    expect(rerun).toMatchObject({ icp_prompt: search.icp_prompt, status: "sourcing", auto_enrich: 0 });
    expect(agentCalls.filter((u) => u.endsWith("/tasks"))).toHaveLength(1);
    // The next one is booked a day out.
    const next = row("SELECT next_refresh_at FROM lists WHERE id = ?", list.id).next_refresh_at;
    expect(Date.parse(next) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    // Booked to the minute: the tick booked when the list was made covers this one.
    expect(jobsFor("/api/jobs/list-tick").some((j) => j.runAt!.slice(0, 16) === next.slice(0, 16))).toBe(true);
    await post(rerun.id, [ana]);
    expect(row("SELECT source_id FROM list_members WHERE list_id = ?", list.id).source_id).toBe(search.id);
  });

  it("a list whose tick was lost gets one when it is read, as its campaigns do hourly", async () => {
    const list = await newList({ refresh: "daily" });
    const at = (ms: number) => new Date(Date.now() - ms).toISOString();
    jobs.length = 0;
    db.prepare("UPDATE lists SET next_refresh_at = ? WHERE id = ?").run(at(60 * 60 * 1000), list.id);
    await ok(`/api/lists/${list.id}/members?email_verified=true`, { headers: APP });
    const tick = jobsFor("/api/jobs/list-tick");
    expect(tick).toHaveLength(1);
    expect(tick[0].payload).toEqual({ listId: list.id });
    expect(Date.parse(tick[0].runAt!)).toBeLessThanOrEqual(Date.now());
    // Due a minute ago is not lost: its own tick is on its way.
    jobs.length = 0;
    db.prepare("UPDATE lists SET next_refresh_at = ? WHERE id = ?").run(at(60 * 1000), list.id);
    await ok("/api/lists", { headers: APP });
    expect(jobsFor("/api/jobs/list-tick")).toHaveLength(0);
    // A list set to off has nothing to re-arm.
    db.prepare("UPDATE lists SET refresh = 'off', next_refresh_at = ? WHERE id = ?").run(at(24 * 60 * 60 * 1000), list.id);
    await ok(`/api/lists/${list.id}`, { headers: APP });
    expect(jobsFor("/api/jobs/list-tick")).toHaveLength(0);
  });

  it("a tick that is not due, and a list set to off, change nothing", async () => {
    const list = await newList({ refresh: "daily" });
    const search = await newSearch();
    await ok(`/api/lists/${list.id}/sources`, { method: "POST", body: { kind: "search", source_id: search.id } });
    expect((await deliver(jobsFor("/api/jobs/list-tick")[0])).body.refreshed).toBe(false);
    await ok(`/api/lists/${list.id}`, { method: "PATCH", body: { refresh: "off" } });
    expect(row("SELECT next_refresh_at FROM lists WHERE id = ?", list.id).next_refresh_at).toBeNull();
    expect(row("SELECT COUNT(*) AS n FROM runs WHERE refresh_of IS NOT NULL").n).toBe(0);
  });

  it("a failed or stalled re-run holds the search until Refresh now; one still working is left alone", async () => {
    const list = await newList({ refresh: "hourly" });
    const search = await newSearch();
    await ok(`/api/lists/${list.id}/sources`, { method: "POST", body: { kind: "search", source_id: search.id } });
    const due = () => db.prepare("UPDATE lists SET next_refresh_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(list.id);
    const tickNow = () => deliver({ targetUrl: "https://prospector.example/api/jobs/list-tick", payload: { listId: list.id } });
    const reruns = () => row("SELECT COUNT(*) AS n FROM runs WHERE refresh_of = ?", search.id).n;

    due();
    await tickNow();
    expect(reruns()).toBe(1);
    // Still working: the next tick leaves it be.
    due();
    await tickNow();
    expect(reruns()).toBe(1);
    // Failed: held, and the list says so.
    db.prepare("UPDATE runs SET status = 'failed', error = 'Login required' WHERE refresh_of = ?").run(search.id);
    due();
    await tickNow();
    expect(reruns()).toBe(1);
    const detail = await ok(`/api/lists/${list.id}`);
    expect(detail.sources[0]).toMatchObject({ kind: "search", hold: "failed", last_refresh: { status: "failed", error: "Login required" } });
    // Refresh now retries it.
    const now = await ok(`/api/lists/${list.id}/refresh`, { method: "POST" });
    expect(now.started).toBe(1);
    expect(reruns()).toBe(2);
    // Stalled: held too.
    db.prepare("UPDATE runs SET status = 'sourcing', updated_at = datetime('now', '-2 hours') WHERE refresh_of = ?").run(search.id);
    due();
    await tickNow();
    expect(reruns()).toBe(2);
    expect((await ok(`/api/lists/${list.id}`)).sources[0].hold).toBe("stalled");
  });
});

describe("a refresh the agent refuses", () => {
  it("is counted as failed, not started, and holds the search as undelivered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "agent_server_not_ready", detail: "status=error" }, { status: 503 })));
    const list = await newList({ refresh: "daily" });
    const search = await newSearch();
    await ok(`/api/lists/${list.id}/sources`, { method: "POST", body: { kind: "search", source_id: search.id } });
    const r = await ok(`/api/lists/${list.id}/refresh`, { method: "POST" });
    expect(r).toMatchObject({ started: 0, failed: 1 });
    const source = (await ok(`/api/lists/${list.id}`)).sources[0];
    expect(source.hold).toBe("undelivered");
    expect(source.last_refresh.error).not.toBe("");
  });
});

describe("automatic email lookups", () => {
  async function listWithPeople(body: Record<string, unknown>, people = [ana, jan, eva]) {
    const list = await newList(body);
    const search = await newSearch();
    await ok(`/api/lists/${list.id}/sources`, { method: "POST", body: { kind: "search", source_id: search.id } });
    jobs.length = 0;
    await post(search.id, people);
    return list;
  }

  it("with no cap and no readers, nothing is bought", async () => {
    await listWithPeople({ refresh: "off" });
    expect(jobsFor("/api/jobs/enrich-lead")).toHaveLength(0);
    expect(row("SELECT COUNT(*) AS n FROM leads WHERE enrich_status = 'pending'").n).toBe(3);
  });

  it("looks up at most the cap a day, emails only, and goes on after midnight UTC", async () => {
    const list = await listWithPeople({ refresh: "off", email_daily_cap: 2 });
    const lookups = jobsFor("/api/jobs/enrich-lead");
    expect(lookups).toHaveLength(2);
    expect(lookups.every((j) => j.payload.refresh === false)).toBe(true);
    expect(rows("SELECT enrich_fields FROM leads WHERE enrich_status = 'running'").map((r) => r.enrich_fields)).toEqual(["email", "email"]);
    expect((await ok("/api/lists")).lists[0]).toMatchObject({ effective_daily_cap: 2, lookups_today: 2 });
    // The third waits for tomorrow: a tick is booked just after midnight UTC.
    const midnight = new Date();
    midnight.setUTCHours(24, 1, 0, 0);
    const tomorrow = jobsFor("/api/jobs/list-tick").find((j) => j.runAt === midnight.toISOString());
    expect(tomorrow).toBeTruthy();

    // A lookup buys the email and never the phone, though a run with no fields set would buy both.
    await deliver(lookups[0]);
    expect(bought).toEqual(["email"]);
    expect(row("SELECT email, enrich_status FROM leads WHERE id = ?", lookups[0].payload.leadId)).toMatchObject({ email: "ana@acme.example", enrich_status: "done" });

    // Tomorrow: the counter is yesterday's, so the last one starts.
    db.prepare("UPDATE lists SET lookups_day = '2020-01-01' WHERE id = ?").run(list.id);
    await deliver(tomorrow!);
    expect(jobsFor("/api/jobs/enrich-lead")).toHaveLength(3);
    expect(row("SELECT COUNT(*) AS n FROM leads WHERE enrich_status = 'pending'").n).toBe(0);
  });

  it("with no cap of its own, a list looks up what its readers take a day", async () => {
    const list = await listWithPeople({ refresh: "off" });
    await ok(`/api/lists/${list.id}/consumers/opensequence:builders`, { method: "PUT", body: { name: "Builders NL", daily: 1 }, headers: APP });
    expect(jobsFor("/api/jobs/enrich-lead")).toHaveLength(1);
    const detail = await ok(`/api/lists/${list.id}`);
    expect(detail.cap_from).toBe("consumers");
    expect(detail.list.effective_daily_cap).toBe(1);
    expect(detail.consumers).toEqual([expect.objectContaining({ key: "opensequence:builders", name: "Builders NL", daily: 1 })]);
    await ok(`/api/lists/${list.id}/consumers/opensequence:builders`, { method: "DELETE", headers: APP });
    expect((await ok(`/api/lists/${list.id}`)).list.effective_daily_cap).toBe(0);
  });

  it("someone already looked up is never bought again", async () => {
    await listWithPeople({ refresh: "off", email_daily_cap: 10 }, [ana]);
    await deliver(jobsFor("/api/jobs/enrich-lead")[0]);
    const list = (await ok("/api/lists")).lists[0];
    jobs.length = 0;
    await ok(`/api/lists/${list.id}/refresh`, { method: "POST" });
    expect(jobsFor("/api/jobs/enrich-lead")).toHaveLength(0);
  });

  it("a person's own Enrich buys the search's fields again", async () => {
    await listWithPeople({ refresh: "off", email_daily_cap: 1 }, [ana]);
    const leadId = jobsFor("/api/jobs/enrich-lead")[0].payload.leadId;
    db.prepare("UPDATE leads SET enrich_status = 'done' WHERE id = ?").run(leadId);
    bought.length = 0;
    const r = await request(`/api/leads/${leadId}/enrich`, { method: "POST" });
    expect(r.status).toBe(202);
    await deliver(jobs[jobs.length - 1]);
    expect(bought).toEqual(["email", "phone"]);
  });
});
