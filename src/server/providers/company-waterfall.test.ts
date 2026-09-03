// The company runner decides whether a user's firmographic credits get spent,
// so its ordering / key / store logic is exercised against stub adapters rather
// than trusted to review. Mirrors waterfall.test.ts for the person side.

import { describe, expect, it } from "vitest";
import type { ConnectionsEnv } from "@clawnify/connections";
import {
  COMPANY_CACHE_MAX_AGE_DAYS,
  companyDefaultOrder,
  normalizeDomain,
  runCompanyWaterfall,
  type CompanyStore,
} from "./company";
import type { CompanyProvider, CompanyRecord, CompanyResult } from "./types";

function stub(
  id: string,
  result: Partial<CompanyResult> & { outcome: CompanyResult["outcome"] },
  opts: { throws?: boolean } = {},
): CompanyProvider & { calls: number } {
  const p = {
    id,
    label: id,
    secretName: `${id.toUpperCase()}_API_KEY`,
    signupUrl: "https://example.com",
    calls: 0,
    async enrich(): Promise<CompanyResult> {
      p.calls++;
      if (opts.throws) throw new Error("vendor exploded");
      return { data: null, creditsUsed: 0, ...result };
    },
  };
  return p as CompanyProvider & { calls: number };
}

const RECORD: CompanyRecord = { industry: "Financial Services", city: "Amsterdam", country: "NL" };
/** Every stub's key present, so tests exercise ordering rather than configuration. */
const ENV = { A_API_KEY: "k", B_API_KEY: "k", C_API_KEY: "k" } as unknown as ConnectionsEnv;

function memoryStore(): CompanyStore & { rows: Map<string, CompanyRecord>; reads: string[] } {
  const rows = new Map<string, CompanyRecord>();
  const reads: string[] = [];
  return {
    rows,
    reads,
    async get(domain) {
      reads.push(domain);
      return rows.get(domain) ?? null;
    },
    async put(domain, record) {
      rows.set(domain, record);
    },
  };
}

describe("normalizeDomain", () => {
  it("strips scheme, www, path and query", () => {
    expect(normalizeDomain("https://www.Acme.com/about?x=1")).toBe("acme.com");
  });

  it("agrees with the export's join key on a bare www domain", () => {
    expect(normalizeDomain("www.stripe.com")).toBe("stripe.com");
  });

  it("refuses a company name, so it is never spent on as a domain", () => {
    expect(normalizeDomain("Acme Studio")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain(undefined)).toBeNull();
  });

  it("takes the host from an email-shaped value rather than the local part", () => {
    expect(normalizeDomain("ada@acme.com")).toBe("acme.com");
  });
});

describe("runCompanyWaterfall", () => {
  it("stops at the first hit and never calls the vendor behind it", async () => {
    const a = stub("a", { outcome: "hit", data: RECORD, creditsUsed: 1 });
    const b = stub("b", { outcome: "hit", data: RECORD, creditsUsed: 1 });
    const res = await runCompanyWaterfall("acme.com", ENV, { order: ["a", "b"], registry: [a, b] });
    expect(res.data).toEqual(RECORD);
    expect(res.providerId).toBe("a");
    expect(res.totalCredits).toBe(1);
    expect(b.calls).toBe(0);
  });

  it("falls through a miss to the next vendor", async () => {
    const a = stub("a", { outcome: "miss" });
    const b = stub("b", { outcome: "hit", data: RECORD, creditsUsed: 1 });
    const res = await runCompanyWaterfall("acme.com", ENV, { order: ["a", "b"], registry: [a, b] });
    expect(res.providerId).toBe("b");
    expect(a.calls).toBe(1);
  });

  it("treats a 200 carrying an empty record as a miss, not a hit", async () => {
    // Storing it would poison the cache for six months with a row that fills
    // no column, and stop the vendor behind it from ever being asked.
    const a = stub("a", { outcome: "hit", data: {}, creditsUsed: 1 });
    const b = stub("b", { outcome: "hit", data: RECORD, creditsUsed: 1 });
    const res = await runCompanyWaterfall("acme.com", ENV, { order: ["a", "b"], registry: [a, b] });
    expect(res.providerId).toBe("b");
    // The empty answer was still paid for; the ledger must say so.
    expect(res.totalCredits).toBe(2);
  });

  it("skips a vendor with no key and records why", async () => {
    const a = stub("a", { outcome: "hit", data: RECORD, creditsUsed: 1 });
    const res = await runCompanyWaterfall("acme.com", {} as ConnectionsEnv, { order: ["a"], registry: [a] });
    expect(a.calls).toBe(0);
    expect(res.attempts[0]).toMatchObject({ outcome: "unconfigured", creditsUsed: 0 });
    expect(res.attempts[0].detail).toContain("A_API_KEY");
  });

  it("survives an adapter that throws, and carries on to the next", async () => {
    const a = stub("a", { outcome: "hit" }, { throws: true });
    const b = stub("b", { outcome: "hit", data: RECORD, creditsUsed: 1 });
    const res = await runCompanyWaterfall("acme.com", ENV, { order: ["a", "b"], registry: [a, b] });
    expect(res.attempts[0]).toMatchObject({ outcome: "error", creditsUsed: 0 });
    expect(res.providerId).toBe("b");
  });

  it("serves a stored company without calling any vendor", async () => {
    const store = memoryStore();
    store.rows.set("acme.com", RECORD);
    const a = stub("a", { outcome: "hit", data: RECORD, creditsUsed: 1 });
    const res = await runCompanyWaterfall("https://www.acme.com/", ENV, { order: ["a"], registry: [a], store });
    expect(res.cached).toBe(true);
    expect(res.totalCredits).toBe(0);
    expect(a.calls).toBe(0);
    // Normalized before the store read, or a `www.` lead would re-buy the row.
    expect(store.reads).toEqual(["acme.com"]);
  });

  it("refresh bypasses the store and re-buys", async () => {
    const store = memoryStore();
    store.rows.set("acme.com", RECORD);
    const a = stub("a", { outcome: "hit", data: RECORD, creditsUsed: 1 });
    const res = await runCompanyWaterfall("acme.com", ENV, { order: ["a"], registry: [a], store, refresh: true });
    expect(res.cached).toBe(false);
    expect(a.calls).toBe(1);
  });

  it("writes a hit to the store so the next lead at that company is free", async () => {
    const store = memoryStore();
    const a = stub("a", { outcome: "hit", data: RECORD, creditsUsed: 1 });
    await runCompanyWaterfall("acme.com", ENV, { order: ["a"], registry: [a], store });
    expect(store.rows.get("acme.com")).toEqual(RECORD);
  });

  it("spends nothing on a lead with no usable domain", async () => {
    const a = stub("a", { outcome: "hit", data: RECORD, creditsUsed: 1 });
    const res = await runCompanyWaterfall("Acme Studio", ENV, { order: ["a"], registry: [a] });
    expect(a.calls).toBe(0);
    expect(res.attempts).toHaveLength(0);
    expect(res.totalCredits).toBe(0);
  });

  it("logs every attempt against the company field, so one ledger covers both subjects", async () => {
    const a = stub("a", { outcome: "miss" });
    const b = stub("b", { outcome: "hit", data: RECORD, creditsUsed: 1 });
    const res = await runCompanyWaterfall("acme.com", ENV, { order: ["a", "b"], registry: [a, b] });
    expect(res.attempts.map((x) => x.field)).toEqual(["company", "company"]);
  });

  it("ignores an id in the order that no adapter serves", async () => {
    const a = stub("a", { outcome: "hit", data: RECORD, creditsUsed: 1 });
    const res = await runCompanyWaterfall("acme.com", ENV, { order: ["ghost", "a"], registry: [a] });
    expect(res.providerId).toBe("a");
    expect(res.attempts).toHaveLength(1);
  });
});

describe("company waterfall defaults", () => {
  it("trusts a company record for longer than a contact's email", async () => {
    // Firmographics decay in years, contact data in weeks. If these ever match,
    // the app is re-buying stable data on the contact clock.
    const { CACHE_MAX_AGE_DAYS } = await import("./index");
    expect(COMPANY_CACHE_MAX_AGE_DAYS).toBeGreaterThan(CACHE_MAX_AGE_DAYS);
  });

  it("leaves no registered adapter unreachable from the default order", async () => {
    const { COMPANY_REGISTRY } = await import("./company");
    expect([...companyDefaultOrder()].sort()).toEqual(COMPANY_REGISTRY.map((p) => p.id).sort());
  });
});
