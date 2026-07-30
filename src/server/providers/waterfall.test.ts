// The waterfall runner decides whether a user's vendor credits get spent, so
// its ordering / eligibility / cache logic is exercised against stub adapters
// rather than trusted to review.

import { describe, expect, it, vi } from "vitest";
import type { ConnectionsEnv } from "@clawnify/connections";
import { runWaterfall, cacheKey, CACHE_MAX_AGE_DAYS, type EnrichCache } from "./index";
import type { EnrichField, EnrichProvider, EnrichResult, LeadInput } from "./types";

/** Build a stub adapter whose `find` returns a scripted result. */
function stub(
  id: string,
  result: Partial<EnrichResult> & { outcome: EnrichResult["outcome"] },
  opts: { requires?: (keyof LeadInput)[]; fields?: EnrichField[]; throws?: boolean } = {},
): EnrichProvider & { calls: number } {
  const p = {
    id,
    label: id,
    fields: opts.fields ?? (["email"] as const),
    secretName: `${id.toUpperCase()}_API_KEY`,
    signupUrl: "https://example.com",
    calls: 0,
    requirements: () => (opts.requires ?? ["fullName", "domain"]) as readonly (keyof LeadInput)[],
    async find(): Promise<EnrichResult> {
      p.calls++;
      if (opts.throws) throw new Error("vendor exploded");
      return { value: null, verified: false, creditsUsed: 0, ...result };
    },
  };
  return p as EnrichProvider & { calls: number };
}

const LEAD: LeadInput = { fullName: "Ada Lovelace", domain: "acme.com" };

/** Every stub is "configured" unless a test omits its key. */
function envWith(...ids: string[]): ConnectionsEnv {
  return Object.fromEntries(ids.map((id) => [`${id.toUpperCase()}_API_KEY`, "test-key"])) as ConnectionsEnv;
}

describe("runWaterfall", () => {
  it("stops at the first verified hit and never calls later providers", async () => {
    const a = stub("a", { outcome: "miss" });
    const b = stub("b", { outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });
    const c = stub("c", { outcome: "hit", value: "wrong@acme.com", verified: true, creditsUsed: 1 });

    const res = await runWaterfall("email", LEAD, envWith("a", "b", "c"), {
      order: ["a", "b", "c"],
      registry: [a, b, c],
    });

    expect(res.value).toBe("ada@acme.com");
    expect(res.providerId).toBe("b");
    expect(res.verified).toBe(true);
    expect(c.calls).toBe(0); // the whole point of a waterfall
    expect(res.totalCredits).toBe(1);
  });

  it("keeps searching past an unverified hit, and returns it only as a fallback", async () => {
    const a = stub("a", { outcome: "hit", value: "guess@acme.com", verified: false, creditsUsed: 1 });
    const b = stub("b", { outcome: "miss" });

    const res = await runWaterfall("email", LEAD, envWith("a", "b"), { order: ["a", "b"], registry: [a, b] });

    expect(b.calls).toBe(1); // did not stop on the unverified value
    expect(res.value).toBe("guess@acme.com");
    expect(res.verified).toBe(false);
  });

  it("prefers a later verified hit over an earlier unverified one", async () => {
    const a = stub("a", { outcome: "hit", value: "guess@acme.com", verified: false, creditsUsed: 1 });
    const b = stub("b", { outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });

    const res = await runWaterfall("email", LEAD, envWith("a", "b"), { order: ["a", "b"], registry: [a, b] });

    expect(res.value).toBe("ada@acme.com");
    expect(res.verified).toBe(true);
    expect(res.totalCredits).toBe(2);
  });

  it("skips unconfigured providers without spending, but records why", async () => {
    const a = stub("a", { outcome: "hit", value: "x@acme.com", verified: true, creditsUsed: 1 });
    const b = stub("b", { outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });

    // Only b has a key.
    const res = await runWaterfall("email", LEAD, envWith("b"), { order: ["a", "b"], registry: [a, b] });

    expect(a.calls).toBe(0);
    expect(res.value).toBe("ada@acme.com");
    expect(res.attempts[0]).toMatchObject({ providerId: "a", outcome: "unconfigured", creditsUsed: 0 });
  });

  it("skips providers whose required inputs are missing", async () => {
    const needsLinkedin = stub("a", { outcome: "hit", value: "x@acme.com", verified: true }, { requires: ["linkedinUrl"] });
    const b = stub("b", { outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });

    const res = await runWaterfall("email", LEAD, envWith("a", "b"), { order: ["a", "b"], registry: [needsLinkedin, b] });

    expect(needsLinkedin.calls).toBe(0);
    expect(res.attempts[0]).toMatchObject({ providerId: "a", outcome: "ineligible" });
    expect(res.value).toBe("ada@acme.com");
  });

  it("survives a provider that throws and continues down the waterfall", async () => {
    const a = stub("a", { outcome: "hit" }, { throws: true });
    const b = stub("b", { outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });

    const res = await runWaterfall("email", LEAD, envWith("a", "b"), { order: ["a", "b"], registry: [a, b] });

    expect(res.attempts[0]).toMatchObject({ providerId: "a", outcome: "error" });
    expect(res.value).toBe("ada@acme.com");
  });

  it("returns a cache hit without calling any provider or spending a credit", async () => {
    const a = stub("a", { outcome: "hit", value: "x@acme.com", verified: true, creditsUsed: 1 });
    const cache: EnrichCache = {
      get: vi.fn(async () => ({ value: "cached@acme.com", verified: true, providerId: "a" })),
      put: vi.fn(async () => {}),
    };

    const res = await runWaterfall("email", LEAD, envWith("a"), { order: ["a"], registry: [a], cache });

    expect(a.calls).toBe(0);
    expect(res.cached).toBe(true);
    expect(res.totalCredits).toBe(0);
    expect(res.value).toBe("cached@acme.com");
  });

  it("hands the cache a staleness cap so entries cannot live forever", async () => {
    const a = stub("a", { outcome: "hit", value: "x@acme.com", verified: true, creditsUsed: 1 });
    const cache: EnrichCache = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };

    await runWaterfall("email", LEAD, envWith("a"), { order: ["a"], registry: [a], cache });
    expect(cache.get).toHaveBeenCalledWith("email", expect.anything(), CACHE_MAX_AGE_DAYS);

    await runWaterfall("email", LEAD, envWith("a"), { order: ["a"], registry: [a], cache, maxCacheAgeDays: 7 });
    expect(cache.get).toHaveBeenLastCalledWith("email", expect.anything(), 7);
  });

  it("bypasses the cache when refresh is set", async () => {
    const a = stub("a", { outcome: "hit", value: "fresh@acme.com", verified: true, creditsUsed: 1 });
    const cache: EnrichCache = {
      get: vi.fn(async () => ({ value: "stale@acme.com", verified: true, providerId: "a" })),
      put: vi.fn(async () => {}),
    };

    const res = await runWaterfall("email", LEAD, envWith("a"), { order: ["a"], registry: [a], cache, refresh: true });

    expect(cache.get).not.toHaveBeenCalled();
    expect(res.value).toBe("fresh@acme.com");
    expect(cache.put).toHaveBeenCalled();
  });

  it("does not cache an unverified value, so a better waterfall can retry it later", async () => {
    const a = stub("a", { outcome: "hit", value: "guess@acme.com", verified: false, creditsUsed: 1 });
    const cache: EnrichCache = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };

    await runWaterfall("email", LEAD, envWith("a"), { order: ["a"], registry: [a], cache });

    expect(cache.put).not.toHaveBeenCalled();
  });

  it("ignores providers that cannot resolve the requested field", async () => {
    const phoneOnly = stub("a", { outcome: "hit", value: "+1555", verified: true }, { fields: ["phone"] });
    const b = stub("b", { outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });

    const res = await runWaterfall("email", LEAD, envWith("a", "b"), { order: ["a", "b"], registry: [phoneOnly, b] });

    expect(phoneOnly.calls).toBe(0);
    expect(res.attempts.some((x) => x.providerId === "a")).toBe(false);
    expect(res.value).toBe("ada@acme.com");
  });
});

describe("cacheKey", () => {
  it("normalizes so trivially different spellings share one cached lookup", () => {
    const a = cacheKey("email", { fullName: "Ada Lovelace", domain: "www.Acme.com" });
    const b = cacheKey("email", { firstName: "ada", lastName: "lovelace", domain: "acme.com" });
    expect(a).toBe(b);
  });

  it("separates fields so an email hit never satisfies a phone lookup", () => {
    const lead = { fullName: "Ada Lovelace", domain: "acme.com" };
    expect(cacheKey("email", lead)).not.toBe(cacheKey("phone", lead));
  });
});
