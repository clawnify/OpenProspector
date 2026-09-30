import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

let db: DatabaseSync;
vi.mock("./db.js", () => ({
  get: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).get(...values),
  query: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).all(...values),
  run: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).run(...values),
}));

// Every waterfall answers from here, so no vendor is ever called. Records the
// field and the refresh flag each pass ran with.
const passes: { field: string; refresh: boolean }[] = [];
vi.mock("./providers/index.js", async (original) => {
  const real = await original<typeof import("./providers/index.js")>();
  return {
    ...real,
    runWaterfall: async (field: string, _input: unknown, _env: unknown, opts: { refresh?: boolean }) => {
      passes.push({ field, refresh: Boolean(opts.refresh) });
      const value = field === "email" ? "ana@acme.example" : null;
      return { field, value, verified: Boolean(value), providerId: value ? "findymail" : null, cached: false, totalCredits: 0, attempts: [] };
    },
  };
});

// The queue client as it behaves for real: it refuses without a token. Jobs
// are delivered by hand below, and only a delivery carrying the test signature
// verifies.
const SIGNATURE = "test-signature";
const enqueued: { targetUrl: string; payload: unknown }[] = [];
vi.mock("@clawnify/queue", () => ({
  enqueueJob: async (env: { CLAWNIFY_TOKEN?: string }, opts: { targetUrl: string; payload?: unknown }) => {
    if (!env.CLAWNIFY_TOKEN) throw new Error("CLAWNIFY_TOKEN is not set");
    enqueued.push({ targetUrl: opts.targetUrl, payload: opts.payload });
    return { id: `job-${enqueued.length}`, status: "pending", run_at: new Date().toISOString() };
  },
  verifyDelivery: async (_raw: string, headers: { signature?: string | null }) => headers.signature === SIGNATURE,
}));

import app from "./index";

// The app's middleware only checks that a D1 binding exists; every query this
// file makes goes through the mocked ./db.js above, never through this stub.
const DB = { prepare: () => { throw new Error("queries must go through the mocked ./db.js"); } };
const withQueue = { CLAWNIFY_TOKEN: "test-only-token", DB };
// Local `wrangler dev`: no platform token, so no queue.
const withoutQueue = { DB };

async function request(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}, env: object = withQueue) {
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

const enrich = (id: string, query = "", env: object = withQueue) => request(`/api/leads/${id}/enrich${query}`, { method: "POST" }, env);

/** Deliver the most recently queued job, the way the queue would. */
function deliver(job = enqueued[enqueued.length - 1], signature = SIGNATURE) {
  return request(new URL(job.targetUrl).pathname, { method: "POST", body: job.payload, headers: { "X-Queue-Signature": signature } });
}

function insertLead(status = "pending", minutesAgo = 0): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO leads (id, full_name, company, domain, enrich_status, updated_at)
     VALUES (?, 'Ana Test', 'Acme', 'acme.example', ?, datetime('now', ?))`,
  ).run(id, status, `-${minutesAgo} minutes`);
  return id;
}

const lead = (id: string) => db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Record<string, unknown>;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  passes.length = 0;
  enqueued.length = 0;
  // Nothing here should reach the network; fail loudly if something tries.
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in tests");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe("POST /api/leads/{id}/enrich", () => {
  it("queues the waterfall and answers at once, with the lead running", async () => {
    const id = insertLead();
    const r = await enrich(id);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.queued).toBe(true);
    expect(r.body.lead.enrich_status).toBe("running");
    expect(r.body.lead.stale).toBe(0);
    // Nothing ran inside the request: that is the whole point.
    expect(passes).toEqual([]);
    expect(enqueued).toEqual([{ targetUrl: "https://prospector.example/api/jobs/enrich-lead", payload: { leadId: id, refresh: false } }]);
  });

  it("starts no second pass while one is in flight", async () => {
    const id = insertLead();
    await enrich(id);
    const again = await enrich(id, "?refresh=true");
    expect(again.status).toBe(202);
    expect(again.body.lead.enrich_status).toBe("running");
    expect(enqueued).toHaveLength(1);
  });

  it("re-runs a lead whose pass was interrupted", async () => {
    const id = insertLead("running", 20);
    const r = await enrich(id);
    expect(r.status).toBe(202);
    expect(enqueued).toHaveLength(1);
    // Claimed again, so the clock restarted.
    expect(r.body.lead.stale).toBe(0);
  });

  it("drops a waiting lead's pause when it is re-run", async () => {
    const id = insertLead("waiting");
    db.prepare(
      `INSERT INTO pending_enrichments (id, lead_id, field, provider_id, position, expires_at)
       VALUES (?, ?, 'email', 'dropcontact', 3, datetime('now', '+10 minutes'))`,
    ).run(crypto.randomUUID(), id);
    await enrich(id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_enrichments WHERE lead_id = ?").get(id)).toEqual({ n: 0 });
    expect(lead(id).enrich_status).toBe("running");
  });

  it("runs inline when the deployment has no queue", async () => {
    const id = insertLead();
    const r = await enrich(id, "", withoutQueue);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.queued).toBe(false);
    expect(r.body.lead.enrich_status).toBe("done");
    expect(r.body.lead.email).toBe("ana@acme.example");
    expect(enqueued).toEqual([]);
  });

  it("404s an unknown lead without queueing anything", async () => {
    const r = await enrich(crypto.randomUUID());
    expect(r.status).toBe(404);
    expect(enqueued).toEqual([]);
  });
});

describe("POST /api/jobs/enrich-lead", () => {
  it("runs the queued lead to done, with the refresh the user asked for", async () => {
    const id = insertLead();
    await enrich(id, "?refresh=true");
    const r = await deliver();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(lead(id).enrich_status).toBe("done");
    expect(lead(id).email).toBe("ana@acme.example");
    expect(passes).toEqual([
      { field: "email", refresh: true },
      { field: "phone", refresh: true },
    ]);
  });

  it("does nothing when a finished job is delivered again", async () => {
    const id = insertLead();
    await enrich(id);
    await deliver();
    passes.length = 0;
    const r = await deliver();
    expect(r.status).toBe(200);
    expect(r.body.skipped).toBe(true);
    expect(passes).toEqual([]);
  });

  it("refuses a delivery the queue did not sign", async () => {
    const id = insertLead();
    await enrich(id);
    const r = await deliver(undefined, "forged");
    expect(r.status).toBe(401);
    expect(lead(id).enrich_status).toBe("running");
    expect(passes).toEqual([]);
  });
});

describe("stale", () => {
  it("flags a lead left running past the window, in the list and on its own", async () => {
    const stuck = insertLead("running", 20);
    const fresh = insertLead("running", 1);
    const settled = insertLead("done", 20);
    const list = await request("/api/leads");
    expect(list.status).toBe(200);
    expect(Object.fromEntries(list.body.leads.map((l: { id: string; stale: number }) => [l.id, l.stale]))).toEqual({
      [stuck]: 1,
      [fresh]: 0,
      [settled]: 0,
    });
    expect((await request(`/api/leads/${stuck}`)).body.lead.stale).toBe(1);
  });
});
