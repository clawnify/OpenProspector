import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

let db: DatabaseSync;
vi.mock("./db.js", () => ({
  get: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).get(...values),
  query: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).all(...values),
  run: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).run(...values),
}));

// Stands in for the vendors. Each call is recorded, and answers from `answers`
// in turn; a verified answer is cached the way the real runner caches it, so
// the cache assertions below test the jump, not the stub.
type Answer = { value: string | null; verified: boolean; providerId: string | null; attempts?: { providerId: string; outcome: string; creditsUsed: number }[] };
const calls: { field: string; input: Record<string, unknown>; order: string[]; refresh?: boolean }[] = [];
let answers: Answer[] = [];
vi.mock("./providers/index.js", async (original) => {
  const real = await original<typeof import("./providers/index.js")>();
  return {
    ...real,
    runWaterfall: async (field: string, input: Record<string, unknown>, _env: unknown, opts: { order: string[]; refresh?: boolean; cache?: { put: Function } }) => {
      calls.push({ field, input, order: opts.order, refresh: opts.refresh });
      const a = answers.shift() ?? { value: null, verified: false, providerId: null };
      if (a.value && a.verified) await opts.cache?.put(field, real.normalize(input), { value: a.value, verified: true, providerId: a.providerId });
      const attempts = (a.attempts ?? []).map((t) => ({ ...t, field, ms: 1, detail: "" }));
      return { field, value: a.value, verified: a.verified, providerId: a.providerId, cached: false, totalCredits: 0, attempts };
    },
  };
});

import app from "./index";
import { enrichLead } from "./enrich";

// The app's middleware only checks that a D1 binding exists; every query goes
// through the mocked ./db.js above.
const env = {
  CLAWNIFY_TOKEN: "test-only-token",
  DB: { prepare: () => { throw new Error("queries must go through the mocked ./db.js"); } },
};

async function request(path: string, method = "GET") {
  const res = await app.request(`https://prospector.example${path}`, { method, headers: { "content-type": "application/json" } }, env);
  return { status: res.status, body: (await res.json()) as any };
}

const PLACEHOLDER = "email1@example.com";

function addLead(overrides: Record<string, string | number> = {}): string {
  const row = { id: crypto.randomUUID(), full_name: "Nikki Parry-Wulff", company: "ASUS", domain: "asus.com", email: PLACEHOLDER, email_verified: 0, email_provider: "contactout", enrich_status: "done", ...overrides };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO leads (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(row));
  return String(row.id);
}

function addAttempt(leadId: string, providerId: string, outcome: string) {
  db.prepare("INSERT INTO enrichment_attempts (id, lead_id, provider_id, field, outcome) VALUES (?, ?, ?, 'email', ?)").run(crypto.randomUUID(), leadId, providerId, outcome);
}

function cached(): string[] {
  return (db.prepare("SELECT value FROM enrichment_cache WHERE cache_key = 'email|nikki parry-wulff|asus.com'").all() as { value: string }[]).map((r) => r.value);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  calls.length = 0;
  answers = [];
});
afterEach(() => db.close());

describe("POST /api/leads/{id}/next-provider", () => {
  it("asks only providers that have not answered, never callback vendors, and not by the rejected email", async () => {
    const id = addLead();
    addAttempt(id, "findymail", "miss");
    addAttempt(id, "anymailfinder", "unconfigured");
    addAttempt(id, "hunter", "error");
    addAttempt(id, "contactout", "hit");

    const r = await request(`/api/leads/${id}/next-provider`, "POST");
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    expect(calls).toHaveLength(1);
    const { order, input, refresh } = calls[0];
    // Answered already: skipped. Never answered (no key, an error): asked again.
    expect(order).not.toContain("findymail");
    expect(order).not.toContain("contactout");
    expect(order).toContain("anymailfinder");
    expect(order).toContain("hunter");
    // Callback-only for email: out of scope for a jump. Apollo is callback-only
    // for phone, not email, so it stays.
    expect(order).not.toContain("dropcontact");
    expect(order).not.toContain("zeliq");
    expect(order).toContain("apollo");
    // The cache would hand back the value being skipped, and several vendors
    // look a person up by the email they are given.
    expect(refresh).toBe(true);
    expect(input.email).toBeUndefined();
    expect(input.fullName).toBe("Nikki Parry-Wulff");
  });

  it("makes a new email current and keeps the one it replaced as an older find", async () => {
    const id = addLead();
    answers = [{ value: "nikki@asus.com", verified: true, providerId: "apollo", attempts: [{ providerId: "apollo", outcome: "hit", creditsUsed: 1 }] }];

    const r = await request(`/api/leads/${id}/next-provider`, "POST");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ outcome: "found", provider_id: "apollo", asked: 1, credits_used: 1 });
    expect(r.body.lead).toMatchObject({ email: "nikki@asus.com", email_verified: 1, email_provider: "apollo", enrich_status: "done" });
    expect(r.body.lead.email_older).toMatchObject([{ value: PLACEHOLDER, verified: 0, provider_id: "contactout" }]);

    // The list is what the table reads, and the ledger records the call.
    const list = await request("/api/leads");
    expect(list.body.leads[0].email_older).toMatchObject([{ value: PLACEHOLDER, provider_id: "contactout" }]);
    expect(db.prepare("SELECT provider_id, outcome FROM enrichment_attempts WHERE lead_id = ?").all(id)).toMatchObject([{ provider_id: "apollo", outcome: "hit" }]);
    expect(cached()).toEqual(["nikki@asus.com"]);

    // The next jump skips the provider it just used, and the one before it.
    await request(`/api/leads/${id}/next-provider`, "POST");
    expect(calls[1].order).not.toContain("apollo");
    expect(calls[1].order).not.toContain("contactout");
  });

  it("drops the skipped email from the cache when its replacement is unverified", async () => {
    const id = addLead({ email_verified: 1 });
    db.prepare("INSERT INTO enrichment_cache (cache_key, field, value, verified, provider_id) VALUES ('email|nikki parry-wulff|asus.com', 'email', ?, 1, 'contactout')").run(PLACEHOLDER);
    answers = [{ value: "n.parry@asus.com", verified: false, providerId: "hunter" }];

    const r = await request(`/api/leads/${id}/next-provider`, "POST");
    expect(r.body).toMatchObject({ outcome: "found", provider_id: "hunter" });
    expect(r.body.lead).toMatchObject({ email: "n.parry@asus.com", email_verified: 0 });
    // Unverified values are never cached, so the skipped one must not stay behind.
    expect(cached()).toEqual([]);
  });

  it("changes nothing when the answer is an email the lead already had", async () => {
    const id = addLead({ email: "nikki@asus.com", email_provider: "apollo", email_verified: 1 });
    db.prepare("INSERT INTO lead_finds (id, lead_id, field, value, provider_id) VALUES (?, ?, 'email', ?, 'contactout')").run(crypto.randomUUID(), id, PLACEHOLDER);
    answers = [{ value: "EMAIL1@example.com", verified: true, providerId: "tomba" }];

    const r = await request(`/api/leads/${id}/next-provider`, "POST");
    expect(r.body).toMatchObject({ outcome: "same", provider_id: "tomba" });
    expect(r.body.lead).toMatchObject({ email: "nikki@asus.com", email_provider: "apollo" });
    expect(r.body.lead.email_older).toHaveLength(1);
    // The runner cached the verified answer; the jump takes it back out, since
    // the lead shows a different value.
    expect(cached()).toEqual([]);
  });

  it("reports when no provider is left to ask", async () => {
    const id = addLead();
    db.prepare("INSERT INTO waterfall_config (field, provider_order) VALUES ('email', ?)").run(JSON.stringify(["contactout", "dropcontact"]));

    const r = await request(`/api/leads/${id}/next-provider`, "POST");
    expect(r.body).toMatchObject({ outcome: "none", asked: 0, credits_used: 0 });
    expect(calls[0].order).toEqual([]);
    expect(r.body.lead.email).toBe(PLACEHOLDER);
  });

  it("refuses a lead with no email, one still being enriched, and an unknown id", async () => {
    expect((await request(`/api/leads/${addLead({ email: "", email_provider: "" })}/next-provider`, "POST")).status).toBe(409);
    expect((await request(`/api/leads/${addLead({ enrich_status: "running" })}/next-provider`, "POST")).status).toBe(409);
    expect((await request(`/api/leads/${addLead({ enrich_status: "waiting" })}/next-provider`, "POST")).status).toBe(409);
    expect((await request(`/api/leads/${crypto.randomUUID()}/next-provider`, "POST")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("older finds on any re-enrich", () => {
  it("keeps a replaced email, and takes an older one back out when it becomes current again", async () => {
    const id = addLead({ email: "b@asus.com", email_provider: "hunter", email_verified: 1 });
    db.prepare("INSERT INTO lead_finds (id, lead_id, field, value, provider_id) VALUES (?, ?, 'email', 'a@asus.com', 'findymail')").run(crypto.randomUUID(), id);
    answers = [{ value: "A@asus.com", verified: true, providerId: "findymail" }];

    const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Record<string, unknown>;
    await enrichLead(lead, env as never, { orders: { email: ["findymail"], phone: [] }, companyOrder: [], origin: null, refresh: true });

    expect(db.prepare("SELECT email, email_provider FROM leads WHERE id = ?").get(id)).toMatchObject({ email: "A@asus.com", email_provider: "findymail" });
    expect(db.prepare("SELECT value, provider_id FROM lead_finds WHERE lead_id = ?").all(id)).toMatchObject([{ value: "b@asus.com", provider_id: "hunter" }]);
  });

  it("writes no older find for a first value or an unchanged one", async () => {
    const first = addLead({ email: "", email_provider: "" });
    const same = addLead({ email: "nikki@asus.com", email_provider: "apollo" });
    answers = [
      { value: "nikki@asus.com", verified: true, providerId: "apollo" },
      { value: null, verified: false, providerId: null },
      { value: "Nikki@asus.com", verified: true, providerId: "apollo" },
      { value: null, verified: false, providerId: null },
    ];
    const opts = { orders: { email: ["apollo"], phone: ["apollo"] }, companyOrder: [], origin: null, refresh: true };
    for (const id of [first, same]) {
      await enrichLead(db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Record<string, unknown>, env as never, opts);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM lead_finds").get()).toMatchObject({ n: 0 });
  });
});
