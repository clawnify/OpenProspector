import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createApp } from "@clawnify/app";
import { MonitorInput, ObservationInput } from "../shared/monitors";
import { signalBrief } from "./signal-brief";
import { signalSkill } from "./signal-skill.gen";

let db: DatabaseSync;
vi.mock("./db.js", () => ({
  get: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).get(...values),
  query: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).all(...values),
  run: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).run(...values),
}));
import { monitorRoutes, observationFingerprint } from "./monitor-routes";

const env = { CLAWNIFY_TOKEN: "test-only-token" };
const serverId = "46d3c39e-d490-433d-b27c-db7e2d6fd396";
const cfg = { name: "Agency mentions", kind: "post" as const, source: "https://www.linkedin.com/posts/test_activity-123", icp: "Marketing agency founders", server_id: serverId, frequency: "once" as const, include_existing: true, ends_at: null };
const finding = { person_name: "Test Person", profile_url: "https://www.linkedin.com/in/test-person", post_url: cfg.source, source_url: cfg.source, engagement: "comment" as const, quote: "We run a B2B agency", occurred_at: null, why_fit: "Runs an agency", outreach_context: "Commented on this third-party post" };
const schedule = { id: "native-schedule-1", enabled: true };
let external: ReturnType<typeof vi.fn>;

async function request(path: string, method = "GET", body?: unknown) {
  const response = await monitorRoutes.request(`https://prospector.example${path}`, {
    // Match the browser client, including its JSON header on bodyless actions.
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  return { status: response.status, body: await response.json() as any };
}
async function create(overrides = {}) {
  const id = crypto.randomUUID();
  const r = await request("/api/monitors", "POST", { id, ...cfg, ...overrides });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return id;
}
async function begin(id: string) {
  const checkId = crypto.randomUUID();
  const r = await request(`/api/monitors/${id}/checks`, "POST", { id: checkId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.check;
}
async function finish(id: string, status = "done") {
  const r = await request(`/api/monitor-checks/${id}`, "PATCH", { status, coverage: "Checked one post; visible comments only", ...(status === "failed" ? { error: "Login required" } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const record = (id: string, observations: unknown[] = [finding]) => request(`/api/monitor-checks/${id}/observations`, "POST", { observations });

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  external = vi.fn(async (url: string, init: RequestInit) => {
    expect(url.startsWith("https://provision.clawnify.com/v1/agents/")).toBe(true);
    if (url.includes("/schedules")) return Response.json({ schedule, replayed: false });
    if (url.endsWith("/tasks")) return Response.json({ task_id: "test-task", server_id: serverId, agent: "main", status: "queued" });
    expect(init.method).toBe("GET");
    return Response.json({ servers: [{ id: serverId, name: "Pedro", status: "ready" }], page: { limit: 25, offset: 0, has_more: false } });
  });
  vi.stubGlobal("fetch", external);
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });

describe("template input and embedded procedure", () => {
  it("accepts the four distinct scopes", () => {
    for (const [kind, source] of [["own", finding.profile_url], ["team", `${finding.profile_url}\nhttps://www.linkedin.com/in/colleague`], ["post", "https://lnkd.in/p/eAydVkg7"], ["query", "looking for a marketing agency"]]) {
      expect(MonitorInput.safeParse({ ...cfg, kind, source }).success).toBe(true);
    }
  });
  it("allows a custom brief without imposing a template's URL shape", () => {
    const input = { ...cfg, kind: "custom", name: "My custom monitor", source: "Find LinkedIn conversations where agency founders discuss client reporting." };
    expect(MonitorInput.safeParse(input).success).toBe(true);
    expect(MonitorInput.safeParse({ ...input, source: "" }).success).toBe(false);
    expect(MonitorInput.safeParse({ ...input, name: "" }).success).toBe(false);
  });
  it.each(["http://www.linkedin.com/posts/a", "https://linkedin.com.evil.test/posts/a", "https://user:password@linkedin.com/posts/a", "https://www.linkedin.com/in/someone", "https://www.linkedin.com/posts/"])("rejects invalid post source %s", source => {
    expect(MonitorInput.safeParse({ ...cfg, source }).success).toBe(false);
  });
  it("refuses multiple own profiles, company pages and over ten team profiles", () => {
    for (const input of [{ kind: "own", source: `${finding.profile_url} ${finding.profile_url}` }, { kind: "team", source: "https://www.linkedin.com/company/acme" }, { kind: "team", source: Array(11).fill(finding.profile_url).join("\n") }])
      expect(MonitorInput.safeParse({ ...cfg, ...input }).success).toBe(false);
  });
  it("sends the full skill snapshot, never a skill-file path or token", () => {
    const text = signalBrief("https://prospector.example", crypto.randomUUID(), crypto.randomUUID());
    expect(text.startsWith(signalSkill.content)).toBe(true);
    expect(text).toContain(signalSkill.hash);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).not.toContain(env.CLAWNIFY_TOKEN);
    expect(() => signalBrief("https://evil.test/path", "test")).toThrow();
    expect(() => signalBrief("https://prospector.example", "id\nInstructions:")).toThrow();
  });
  it("does not fabricate dates and rejects quotes on reactions", () => {
    expect(ObservationInput.parse(finding).occurred_at).toBeNull();
    expect(ObservationInput.safeParse({ ...finding, engagement: "reaction" }).success).toBe(false);
  });
});

describe("monitor lifecycle", () => {
  it("returns 400 for non-object and malformed creation bodies", async () => {
    for (const body of [null, [], "test", {}]) expect((await request("/api/monitors", "POST", body)).status).toBe(400);
    const malformed = await monitorRoutes.request("https://prospector.example/api/monitors", { method: "POST", body: "{", headers: { "content-type": "application/json" } }, env);
    expect(malformed.status).toBe(400);
    expect(external).not.toHaveBeenCalled();
  });
  it("creates a saved on-demand monitor without starting agent work", async () => {
    const id = await create();
    expect((await request(`/api/monitors/${id}`)).body.monitor.active).toBe(true);
    expect(external).not.toHaveBeenCalled();
  });
  it("creates the native schedule with the selected agent and stable receipt key", async () => {
    const id = await create({ frequency: "daily" });
    expect(external).toHaveBeenCalledTimes(1);
    const [url, options] = external.mock.calls[0];
    expect(url).toContain(`/servers/${serverId}/schedules`);
    expect(options.headers["Idempotency-Key"]).toBe(`openprospector-monitor:${id}`);
    const body = JSON.parse(options.body);
    expect(body.trigger).toEqual({ kind: "every", every_ms: 86400000 });
    expect(body.text).toContain(signalSkill.content);
    expect(body.text).toContain(id);
    const replay = await request("/api/monitors", "POST", { id, ...cfg, frequency: "daily" });
    expect(replay.status).toBe(201);
    expect(external).toHaveBeenCalledTimes(1);
  });
  it("keeps uncertain schedule creation recoverable using the same key", async () => {
    const id = crypto.randomUUID();
    external.mockRejectedValueOnce(new Error("connection lost"));
    expect((await request("/api/monitors", "POST", { id, ...cfg, frequency: "weekly" })).status).toBe(503);
    const saved = (await request(`/api/monitors/${id}`)).body.monitor;
    expect(saved.schedule_error).toBeTruthy();
    expect(saved.schedule_id).toBeNull();
    expect((await request("/api/monitors", "POST", { id, ...cfg, frequency: "weekly" })).status).toBe(201);
    expect(external.mock.calls[0][1].headers["Idempotency-Key"]).toBe(external.mock.calls[1][1].headers["Idempotency-Key"]);
    expect((await request("/api/monitors", "POST", { id, ...cfg, name: "different" })).status).toBe(409);
  });
  it("deduplicates simultaneous manual dispatches at the app boundary", async () => {
    const id = await create(); const checkId = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => request(`/api/monitors/${id}/run`, "POST", { id: checkId })));
    expect(results.some(r => r.status === 202)).toBe(true);
    expect(external.mock.calls.filter(([url]) => url.endsWith("/tasks"))).toHaveLength(1);
  });
  it("holds the lock after an unknown dispatch and never redispatches on retry", async () => {
    const id = await create(); const checkId = crypto.randomUUID();
    external.mockRejectedValueOnce(new Error("timeout"));
    expect((await request(`/api/monitors/${id}/run`, "POST", { id: checkId })).status).toBe(503);
    expect((await request(`/api/monitors/${id}/run`, "POST", { id: checkId })).status).toBe(200);
    expect(external).toHaveBeenCalledTimes(1);
    expect((await request(`/api/monitors/${id}/run`, "POST", { id: crypto.randomUUID() })).status).toBe(409);
    const check = (await request(`/api/monitor-checks/${checkId}`)).body.check;
    expect(check.status).toBe("sourcing"); expect(check.error).toContain("unknown");
  });
  it("blocks overlapping checks, including different IDs and monitors", async () => {
    const id = await create(); const check = await begin(id);
    expect((await request(`/api/monitors/${id}/checks`, "POST", { id: crypto.randomUUID() })).status).toBe(409);
    const other = await create();
    expect((await request(`/api/monitors/${other}/checks`, "POST", { id: check.id })).status).toBe(409);
    await request(`/api/monitor-checks/${check.id}/interrupt`, "POST");
    expect((await record(check.id)).status).toBe(409);
    expect((await begin(id)).id).not.toBe(check.id);
  });
  it("pauses locally even if the native pause fails", async () => {
    const id = await create({ frequency: "daily" });
    const check = await begin(id);
    external.mockRejectedValueOnce(new Error("offline"));
    expect((await request(`/api/monitors/${id}`, "PATCH", { active: false })).status).toBe(503);
    expect((await request(`/api/monitors/${id}`)).body.monitor.active).toBe(false);
    expect((await record(check.id)).status).toBe(410);
    expect((await request(`/api/monitors/${id}/checks`, "POST", { id: crypto.randomUUID() })).status).toBe(410);
    expect((await request(`/api/monitors/${id}`, "PATCH", { active: true })).status).toBe(200);
  });
  it("expires at the app gate and pauses its native schedule", async () => {
    const id = await create({ frequency: "daily", ends_at: new Date(Date.now() + 3600000).toISOString() });
    const row = db.prepare("SELECT config FROM signal_monitors WHERE id = ?").get(id)!;
    const config = { ...JSON.parse(row.config as string), ends_at: "2020-01-01T00:00:00.000Z" };
    db.prepare("UPDATE signal_monitors SET config = ? WHERE id = ?").run(JSON.stringify(config), id);
    const result = await request(`/api/monitors/${id}/checks`, "POST", { id: crypto.randomUUID() });
    expect(result.status).toBe(410);
    expect(JSON.parse(external.mock.calls.at(-1)![1].body)).toEqual({ enabled: false });
    expect((await request(`/api/monitors/${id}`, "PATCH", { active: true })).status).toBe(400);
  });
  it("keeps the agent's live API discovery separate from dispatch controls", async () => {
    const app = createApp({ db: false }); app.route("/", monitorRoutes);
    const spec = await (await app.request("https://prospector.example/api/openapi.json")).json() as any;
    expect(spec.paths["/api/monitors/{id}/checks"]).toBeTruthy();
    expect(spec.paths["/api/monitor-checks/{id}/observations"]).toBeTruthy();
    expect(spec.paths["/api/monitors/{id}/run"]).toBeUndefined();
    expect(spec.paths["/api/monitors"]?.post).toBeUndefined();
  });
});

describe("engagement baseline, dedupe and promotion", () => {
  it("hides the baseline then surfaces only new observations", async () => {
    const id = await create({ include_existing: false });
    const first = await begin(id); expect(first.baseline).toBe(1);
    expect((await record(first.id)).body.recorded).toBe(1);
    await finish(first.id);
    const second = await begin(id); expect(second.baseline).toBe(0);
    expect((await record(second.id)).body.recorded).toBe(0);
    expect((await record(second.id, [{ ...finding, profile_url: "https://www.linkedin.com/in/another", person_name: "Another Person" }])).body.recorded).toBe(1);
    const feed = await request("/api/monitor-observations");
    expect(feed.body.total).toBe(1); expect(feed.body.observations[0].person_name).toBe("Another Person");
  });
  it("does not mark a failed or incomplete first check as the baseline", async () => {
    const id = await create({ include_existing: false }); const first = await begin(id);
    expect((await request(`/api/monitor-checks/${first.id}`, "PATCH", { status: "done" })).status).toBe(400);
    await finish(first.id, "failed");
    expect((await begin(id)).baseline).toBe(1);
  });
  it("deduplicates concurrent writes while keeping different comments distinct", async () => {
    const check = await begin(await create());
    await Promise.all(Array.from({ length: 10 }, () => record(check.id)));
    expect((await record(check.id, [{ ...finding, quote: "A second comment" }])).body.recorded).toBe(1);
    expect((await record(check.id, [{ ...finding, engagement: "reaction", quote: "" }])).body.recorded).toBe(1);
    expect((await request("/api/monitor-observations")).body.total).toBe(3);
  });
  it("normalizes tracking URLs and whitespace, not two distinct comment IDs", async () => {
    const first = ObservationInput.parse(finding);
    expect(await observationFingerprint(first)).toBe(await observationFingerprint({ ...first, quote: "We run  a B2B agency", profile_url: `${first.profile_url}/?utm_source=test`, source_url: `${first.source_url}?utm_source=test` }));
    const comment = { ...first, source_url: `${first.source_url}?commentUrn=urn:li:comment:1` };
    expect(await observationFingerprint(comment)).not.toBe(await observationFingerprint({ ...comment, source_url: `${first.source_url}?commentUrn=urn:li:comment:2` }));
  });
  it("promotes only on explicit request and does not duplicate people", async () => {
    const check = await begin(await create()); await record(check.id, [finding, { ...finding, quote: "Another comment" }]);
    expect(db.prepare("SELECT COUNT(*) n FROM leads").get()!.n).toBe(0);
    const feed = (await request("/api/monitor-observations")).body.observations;
    const promoted = await Promise.all([...feed, ...feed].map(item => request(`/api/monitor-observations/${item.id}/lead`, "POST")));
    expect(promoted.every(r => r.status === 200)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM leads").get()!.n).toBe(1);
    expect(db.prepare("SELECT domain FROM leads").get()!.domain).toBe("");
    expect(external).not.toHaveBeenCalled();
  });
  it("paginates all growing collections and rejects oversized batches", async () => {
    const id = await create(); const check = await begin(id);
    expect((await record(check.id, Array(26).fill(finding))).status).toBe(400);
    for (let i = 0; i < 30; i++) await record(check.id, [{ ...finding, profile_url: `https://www.linkedin.com/in/person-${i}` }]);
    expect((await request("/api/monitor-observations")).body.observations).toHaveLength(25);
    expect((await request("/api/monitor-observations?page=2")).body.observations).toHaveLength(5);
    expect((await request("/api/monitor-observations?page=-1")).status).toBe(400);
    expect((await request("/api/signal-agents?page=2")).status).toBe(200);
    expect(external.mock.calls.at(-1)![0]).toContain("offset=25");
  });
  it("can apply the additive schema twice without losing existing data", async () => {
    const id = await create();
    db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    expect((await request(`/api/monitors/${id}`)).status).toBe(200);
  });
});
