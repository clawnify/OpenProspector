import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

let db: DatabaseSync;
vi.mock("./db.js", () => ({
  get: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).get(...values),
  query: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).all(...values),
  run: async (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).run(...values),
}));

// Records which waterfalls a lead went through, without calling a vendor.
const waterfalls: string[] = [];
vi.mock("./providers/index.js", async (original) => {
  const real = await original<typeof import("./providers/index.js")>();
  return {
    ...real,
    runWaterfall: async (field: string) => {
      waterfalls.push(field);
      return { field, value: null, verified: false, providerId: null, cached: false, totalCredits: 0, attempts: [] };
    },
  };
});

import app from "./index";
import { enrichLead, resumeLead } from "./enrich";
import {
  INSTRUCTION_CAP,
  SALES_NAV_MAX_URL,
  parseSalesNavigatorUrl,
  salesNavigatorBrief,
} from "./sales-navigator";

const SEARCH = "https://www.linkedin.com/sales/search/people?savedSearchId=1234567";
// The app's middleware only checks that a D1 binding exists; every query this
// file makes goes through the mocked ./db.js above, never through this stub.
const env = {
  CLAWNIFY_TOKEN: "test-only-token",
  DB: { prepare: () => { throw new Error("queries must go through the mocked ./db.js"); } },
};

async function request(path: string, method = "GET", body?: unknown) {
  const res = await app.request(
    `https://prospector.example${path}`,
    { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    env,
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function createRun(include_emails: boolean) {
  const r = await request("/api/runs/sales-navigator", "POST", { url: SEARCH, include_emails });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.run;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  waterfalls.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe("parseSalesNavigatorUrl", () => {
  it("accepts people searches, saved searches and lead lists", () => {
    for (const url of [
      SEARCH,
      "https://www.linkedin.com/sales/search/people?query=(filters%3AList())",
      "https://linkedin.com/sales/lists/people/7012345678901234567?sortCriteria=CREATED_TIME",
    ]) {
      expect(parseSalesNavigatorUrl(url).ok, url).toBe(true);
    }
  });

  it("normalises to https and drops the fragment", () => {
    const r = parseSalesNavigatorUrl("http://www.linkedin.com/sales/search/people?savedSearchId=1#top");
    expect(r).toEqual({ ok: true, url: "https://www.linkedin.com/sales/search/people?savedSearchId=1" });
  });

  it("refuses account lists with a reason, since this export produces people", () => {
    const r = parseSalesNavigatorUrl("https://www.linkedin.com/sales/search/company?savedSearchId=9");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/account search/);
  });

  it("refuses anything that is not a Sales Navigator people list", () => {
    for (const url of [
      "not a url",
      "https://www.linkedin.com/in/someone/",
      "https://evil.example/sales/search/people",
      "https://www.linkedin.com.evil.example/sales/search/people",
      `https://www.linkedin.com/sales/search/people?q=${"x".repeat(SALES_NAV_MAX_URL)}`,
    ]) {
      expect(parseSalesNavigatorUrl(url).ok, url).toBe(false);
    }
  });
});

describe("salesNavigatorBrief", () => {
  // The platform refuses an instruction over its cap, so the longest URL we
  // accept must still produce a brief that fits.
  it("fits the platform's instruction cap with the longest URL accepted", () => {
    const url = `https://www.linkedin.com/sales/search/people?q=${"x".repeat(SALES_NAV_MAX_URL - 60)}`;
    expect(parseSalesNavigatorUrl(url).ok).toBe(true);
    for (const includeEmails of [true, false]) {
      const brief = salesNavigatorBrief({ runId: crypto.randomUUID(), url, appUrl: "https://prospector.example", includeEmails });
      expect(brief.length).toBeLessThanOrEqual(INSTRUCTION_CAP);
    }
  });

  it("only asks the agent to start enrichment when emails were requested", () => {
    const base = { runId: "r1", url: SEARCH, appUrl: "https://prospector.example" };
    expect(salesNavigatorBrief({ ...base, includeEmails: true })).toContain("POST /api/runs/r1/enrich");
    const without = salesNavigatorBrief({ ...base, includeEmails: false });
    expect(without).not.toContain("/enrich");
    expect(without).toContain('{"status":"done"}');
  });
});

describe("POST /api/runs/sales-navigator", () => {
  it("creates an emails-only run and records the include-emails choice", async () => {
    const on = await createRun(true);
    expect(on).toMatchObject({ source: "sales_navigator", icp_prompt: SEARCH, enrich_fields: "email", auto_enrich: 1, status: "pending" });
    const off = await createRun(false);
    // Still emails only: a later manual enrich must not add phone lookups.
    expect(off).toMatchObject({ enrich_fields: "email", auto_enrich: 0 });
  });

  it("rejects a URL it cannot export", async () => {
    const r = await request("/api/runs/sales-navigator", "POST", { url: "https://www.linkedin.com/sales/search/company" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/account search/);
  });

  it("leaves open-web runs as they were", async () => {
    const r = await request("/api/runs", "POST", { icp_prompt: "Dentists in Rotterdam" });
    expect(r.body.run).toMatchObject({ source: "icp", enrich_fields: "email,phone", auto_enrich: 0 });
  });

  it("dispatches the export instruction, not the open-web one", async () => {
    const run = await createRun(true);
    let sent = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)).instruction;
      return new Response(JSON.stringify({ task_id: "t1", server_id: "s1" }), { status: 202 });
    }));
    const r = await request(`/api/runs/${run.id}/dispatch`, "POST");
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(sent).toContain(SEARCH);
    expect(sent).toContain(`POST /api/runs/${run.id}/enrich`);
    expect(sent).not.toContain("Research the live web");
  });
});

describe("importing an exported page", () => {
  const lead = (n: number, extra: Record<string, unknown> = {}) => ({
    full_name: `Person ${n}`,
    title: "Head of Growth",
    company: "Acme",
    domain: "https://www.acme.example/about",
    source: "sales_navigator",
    source_url: `https://www.linkedin.com/sales/lead/ACwAA${n},NAME_SEARCH`,
    industry: "Software Development",
    employee_count: 240,
    company_city: "Amsterdam",
    company_country: "Netherlands",
    company_linkedin_url: "https://www.linkedin.com/company/acme-example",
    ...extra,
  });

  it("skips people already exported to this run, so a retried dispatch does not double the list", async () => {
    const run = await createRun(false);
    await request("/api/leads", "POST", { run_id: run.id, leads: [lead(1), lead(2)] });
    const again = await request("/api/leads", "POST", { run_id: run.id, leads: [lead(2), lead(3), lead(3)] });
    expect(again.body.imported).toBe(1);
    const n = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE run_id = ?").get(run.id) as { n: number };
    expect(n.n).toBe(3);
    const counted = db.prepare("SELECT lead_count FROM runs WHERE id = ?").get(run.id) as { lead_count: number };
    expect(counted.lead_count).toBe(3);
  });

  it("keeps a Sales Navigator lead link as the citation, never as the profile URL", async () => {
    const run = await createRun(false);
    const url = "https://www.linkedin.com/sales/lead/ACwAA9,NAME_SEARCH";
    await request("/api/leads", "POST", { run_id: run.id, leads: [lead(9, { linkedin_url: url, source_url: "" })] });
    const row = db.prepare("SELECT linkedin_url, source_url FROM leads WHERE run_id = ?").get(run.id) as Record<string, string>;
    expect(row).toEqual({ linkedin_url: "", source_url: url });
  });

  it("stores the list's firmographics for free, without overwriting a vendor's", async () => {
    db.prepare("INSERT INTO companies (domain, industry, provider_id) VALUES ('vendor.example', 'Fintech', 'apollo-company')").run();
    const run = await createRun(false);
    await request("/api/leads", "POST", {
      run_id: run.id,
      leads: [lead(1), lead(2, { domain: "vendor.example", industry: "Banking", company_linkedin_url: "https://www.linkedin.com/in/not-a-company" })],
    });
    const acme = db.prepare("SELECT * FROM companies WHERE domain = 'acme.example'").get() as Record<string, unknown>;
    expect(acme).toMatchObject({
      name: "Acme",
      industry: "Software Development",
      employee_count: 240,
      city: "Amsterdam",
      country: "Netherlands",
      linkedin_url: "https://www.linkedin.com/company/acme-example",
      provider_id: "sales_navigator",
    });
    const vendor = db.prepare("SELECT * FROM companies WHERE domain = 'vendor.example'").get() as Record<string, unknown>;
    expect(vendor).toMatchObject({ industry: "Fintech", provider_id: "apollo-company", employee_count: 240, linkedin_url: "" });
  });
});

describe("enrichment follows the run's fields", () => {
  const opts = { orders: { email: [], phone: [] }, companyOrder: [], origin: null };

  it("never runs the phone waterfall for an emails-only export", async () => {
    const run = await createRun(true);
    db.prepare("INSERT INTO leads (id, run_id, full_name, domain) VALUES ('l1', ?, 'Ada Lovelace', 'acme.example')").run(run.id);
    await enrichLead(db.prepare("SELECT * FROM leads WHERE id = 'l1'").get() as Record<string, unknown>, {} as never, opts);
    expect(waterfalls).toEqual(["email"]);
  });

  // Apollo answers some lookups by callback. The resume must not carry an
  // emails-only lead on into the phone waterfall once its email arrives.
  it("stops after the email when a callback resumes an emails-only lead", async () => {
    const run = await createRun(true);
    db.prepare("INSERT INTO leads (id, run_id, full_name, domain, enrich_status) VALUES ('l4', ?, 'Ada', 'acme.example', 'waiting')").run(run.id);
    db.prepare(
      "INSERT INTO pending_enrichments (id, lead_id, run_id, field, provider_id, position, expires_at) VALUES ('tok', 'l4', ?, 'email', 'apollo', 0, datetime('now', '+10 minutes'))",
    ).run(run.id);
    const answer = { outcome: "hit" as const, value: "ada@acme.example", verified: true, creditsUsed: 1 };
    expect(await resumeLead("tok", answer, {} as never, opts)).toBe(true);
    expect(waterfalls).toEqual([]);
    const lead = db.prepare("SELECT email, enrich_status FROM leads WHERE id = 'l4'").get();
    expect(lead).toEqual({ email: "ada@acme.example", enrich_status: "done" });
  });

  it("still runs both for an open-web run and for a lead with no run", async () => {
    const r = await request("/api/runs", "POST", { icp_prompt: "Dentists in Rotterdam" });
    db.prepare("INSERT INTO leads (id, run_id, full_name, domain) VALUES ('l2', ?, 'Ada', 'a.example'), ('l3', NULL, 'Bo', 'b.example')").run(r.body.run.id);
    for (const id of ["l2", "l3"]) {
      await enrichLead(db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Record<string, unknown>, {} as never, opts);
    }
    expect(waterfalls).toEqual(["email", "phone", "email", "phone"]);
  });
});
