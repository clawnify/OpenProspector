/**
 * PATCH and DELETE /api/leads/{id}: a person or agent corrects or removes one
 * lead. Deleting keeps what the lead cost in the ledger and unlinks the signal
 * that found it; its older finds, list places and pauses go with it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

let db: DatabaseSync;
vi.mock("./db.js", () => ({
  get: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).get(...values),
  query: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).all(...values),
  run: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).run(...values),
}));
vi.mock("@clawnify/queue", () => ({
  enqueueJob: async () => ({ id: "job", status: "pending" }),
  verifyDelivery: async () => false,
}));

import app from "./index";

const DB = { prepare: () => { throw new Error("queries must go through the mocked ./db.js"); } };
const env = { CLAWNIFY_TOKEN: "test-only-token", DB };
const AGENT = { "X-Clawnify-Caller": "agent" };
const APP = { "X-Clawnify-Caller": "app" };
const TOKEN = "11111111-1111-1111-1111-111111111111";

async function request(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await app.request(
    `https://prospector.example${path}`,
    {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...AGENT, ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    env,
  );
  return { status: res.status, body: (await res.json()) as any };
}

const row = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).get(...values) as Record<string, any> | undefined;
const count = (sql: string, ...values: (string | number | null)[]) => (db.prepare(sql).get(...values) as { n: number }).n;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  db.exec(`
    INSERT INTO runs (id, icp_prompt, status) VALUES ('run-1', 'Building firms in the Netherlands', 'enriching');
    INSERT INTO leads (id, run_id, full_name, company, domain, email, email_verified, email_provider, enrich_status)
      VALUES ('lead-1', 'run-1', 'Ana de Vries', 'Bouw BV', 'bouw.nl', 'ana@bouw.nl', 1, 'findymail', 'waiting'),
             ('lead-2', 'run-1', 'Jan Smit', 'Smit Bouw', 'smitbouw.nl', '', 0, '', 'done');
    INSERT INTO enrichment_attempts (id, lead_id, run_id, provider_id, field, outcome, credits_used)
      VALUES ('att-1', 'lead-1', 'run-1', 'findymail', 'email', 'hit', 1),
             ('att-2', 'lead-1', 'run-1', 'apollo', 'phone', 'pending', 8),
             ('att-3', 'lead-2', 'run-1', 'findymail', 'email', 'miss', 1);
    INSERT INTO lead_finds (id, lead_id, field, value, provider_id) VALUES ('find-1', 'lead-1', 'email', 'a.devries@bouw.nl', 'hunter');
    INSERT INTO lists (id, name) VALUES ('list-1', 'Builders');
    INSERT INTO list_members (list_id, lead_id, source_kind) VALUES ('list-1', 'lead-1', 'search');
    INSERT INTO signal_monitors (id, config, create_request) VALUES ('mon-1', '{}', '{}');
    INSERT INTO signal_checks (id, monitor_id) VALUES ('chk-1', 'mon-1');
    INSERT INTO signal_observations (id, monitor_id, check_id, fingerprint, details, visible, lead_id)
      VALUES ('obs-1', 'mon-1', 'chk-1', 'fp-1', '{}', 1, 'lead-1');
    INSERT INTO pending_enrichments (id, lead_id, run_id, field, provider_id, position, expires_at)
      VALUES ('${TOKEN}', 'lead-1', 'run-1', 'phone', 'apollo', 0, datetime('now', '+10 minutes'));
  `);
});

describe("DELETE /api/leads/{id}", () => {
  it("removes the lead but keeps what it cost in the ledger and the run's totals", async () => {
    const credits = () => count("SELECT SUM(credits_used) AS n FROM enrichment_attempts WHERE run_id = 'run-1'");
    expect(credits()).toBe(10);

    const res = await request("/api/leads/lead-1", { method: "DELETE" });

    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(row("SELECT id FROM leads WHERE id = 'lead-1'")).toBeUndefined();
    expect(row("SELECT id FROM leads WHERE id = 'lead-2'")).toBeDefined();
    expect(credits()).toBe(10);
    expect(count("SELECT COUNT(*) AS n FROM enrichment_attempts WHERE lead_id IS NULL")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM lead_finds WHERE lead_id = 'lead-1'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM list_members WHERE lead_id = 'lead-1'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM pending_enrichments WHERE lead_id = 'lead-1'")).toBe(0);
    expect(row("SELECT lead_id FROM signal_observations WHERE id = 'obs-1'")).toEqual({ lead_id: null });
  });

  it("lets the run finish when the deleted lead was the last one it waited on", async () => {
    await request("/api/leads/lead-1", { method: "DELETE" });
    expect(row("SELECT status FROM runs WHERE id = 'run-1'")?.status).toBe("done");
  });

  it("answers a late provider callback for a deleted lead with 404", async () => {
    await request("/api/leads/lead-1", { method: "DELETE" });
    const callback = await request(`/api/callbacks/${TOKEN}`, { method: "POST", body: {} });
    expect(callback.status).toBe(404);
  });

  it("refuses a lead mid-enrichment, but not one whose pass was cut off", async () => {
    db.exec("UPDATE leads SET enrich_status = 'running', updated_at = datetime('now') WHERE id = 'lead-2'");
    expect((await request("/api/leads/lead-2", { method: "DELETE" })).status).toBe(409);
    expect(row("SELECT id FROM leads WHERE id = 'lead-2'")).toBeDefined();

    db.exec("UPDATE leads SET updated_at = datetime('now', '-1 hour') WHERE id = 'lead-2'");
    expect((await request("/api/leads/lead-2", { method: "DELETE" })).status).toBe(200);
  });

  it("answers 404 for an unknown lead and 403 to a sibling app", async () => {
    expect((await request("/api/leads/nope", { method: "DELETE" })).status).toBe(404);
    expect((await request("/api/leads/lead-2", { method: "DELETE", headers: APP })).status).toBe(403);
    expect(row("SELECT id FROM leads WHERE id = 'lead-2'")).toBeDefined();
  });
});

describe("PATCH /api/leads/{id}", () => {
  it("sets the fields sent, normalizing the domain, and leaves the rest", async () => {
    const res = await request("/api/leads/lead-2", { method: "PATCH", body: { title: "  Ops lead ", domain: "https://www.SmitBouw.nl/about" } });

    expect(res.status).toBe(200);
    expect(res.body.lead).toMatchObject({ title: "Ops lead", domain: "smitbouw.nl", full_name: "Jan Smit", company: "Smit Bouw" });
  });

  it("keeps a replaced email among the older finds, and the new one has no provider", async () => {
    const res = await request("/api/leads/lead-1", { method: "PATCH", body: { email: "ana.devries@bouw.nl" } });

    expect(res.status).toBe(200);
    expect(res.body.lead).toMatchObject({ email: "ana.devries@bouw.nl", email_verified: 0, email_provider: "" });
    expect(row("SELECT value, provider_id, verified FROM lead_finds WHERE lead_id = 'lead-1' AND value = 'ana@bouw.nl'")).toEqual({
      value: "ana@bouw.nl",
      provider_id: "findymail",
      verified: 1,
    });
  });

  it("keeps how an email was found when the same value is sent again", async () => {
    await request("/api/leads/lead-1", { method: "PATCH", body: { email: "ANA@bouw.nl" } });

    expect(row("SELECT email, email_verified, email_provider FROM leads WHERE id = 'lead-1'")).toEqual({
      email: "ana@bouw.nl",
      email_verified: 1,
      email_provider: "findymail",
    });
    expect(count("SELECT COUNT(*) AS n FROM lead_finds WHERE lead_id = 'lead-1'")).toBe(1);
  });

  it("rejects a field it cannot change, an unknown lead, and a sibling app", async () => {
    expect((await request("/api/leads/lead-1", { method: "PATCH", body: { enrich_status: "done" } })).status).toBe(400);
    expect((await request("/api/leads/nope", { method: "PATCH", body: { title: "x" } })).status).toBe(404);
    expect((await request("/api/leads/lead-1", { method: "PATCH", body: { title: "x" }, headers: APP })).status).toBe(403);
  });
});
