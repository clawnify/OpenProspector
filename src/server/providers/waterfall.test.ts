// The waterfall runner decides whether a user's vendor credits get spent, so
// its ordering / eligibility / cache logic is exercised against stub adapters
// rather than trusted to review.

import { describe, expect, it, vi } from "vitest";
import type { ConnectionsEnv } from "@clawnify/connections";
import {
  runWaterfall,
  applyDeferredResult,
  cacheKey,
  defaultOrder,
  describeRequirements,
  CACHE_MAX_AGE_DAYS,
  DEFAULT_ORDER,
  REGISTRY,
  type EnrichCache,
} from "./index";
import type { EnrichField, EnrichProvider, EnrichResult, InputRequirement, LeadInput } from "./types";

/** Build a stub adapter whose `find` returns a scripted result. */
function stub(
  id: string,
  result: Partial<EnrichResult> & { outcome: EnrichResult["outcome"] },
  opts: { requires?: InputRequirement; fields?: EnrichField[]; throws?: boolean; deferred?: boolean } = {},
): EnrichProvider & { calls: number } {
  const p = {
    id,
    label: id,
    fields: opts.fields ?? (["email"] as const),
    secretName: `${id.toUpperCase()}_API_KEY`,
    signupUrl: "https://example.com",
    ...(opts.deferred ? { deferred: opts.fields ?? (["email"] as const) } : {}),
    calls: 0,
    requirements: () => opts.requires ?? (["fullName", "domain"] as InputRequirement),
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

describe("a hit that carried nothing", () => {
  // The runner has always refused to *use* one of these. What it did not do was
  // say so: the ledger row was written before the check and called it a hit, so
  // a vendor that billed for a response our field names no longer match looked
  // exactly like a vendor that worked. That is response-mapping drift, and the
  // ledger is the only place a user could ever see it.
  it("records an empty hit as unmapped, keeps the charge, and moves on", async () => {
    const a = stub("a", { outcome: "hit", value: null, creditsUsed: 1 });
    const b = stub("b", { outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });

    const res = await runWaterfall("email", LEAD, envWith("a", "b"), {
      order: ["a", "b"],
      registry: [a, b],
    });

    const attempt = res.attempts.find((x) => x.providerId === "a");
    expect(attempt?.outcome).toBe("unmapped");
    // The credit is real and stays on the ledger — relabelling the outcome must
    // not quietly refund a charge the vendor actually made.
    expect(attempt?.creditsUsed).toBe(1);
    expect(attempt?.detail).toMatch(/response mapping/i);

    // And it is a dead end, not a stop: the search continues past it.
    expect(b.calls).toBe(1);
    expect(res.value).toBe("ada@acme.com");
    expect(res.totalCredits).toBe(2);
  });

  it("does not relabel an honest miss", async () => {
    const a = stub("a", { outcome: "miss" });
    const res = await runWaterfall("email", LEAD, envWith("a"), { order: ["a"], registry: [a] });
    // A miss means the vendor has no record — normal, free, and not a bug in us.
    expect(res.attempts[0].outcome).toBe("miss");
  });
});

describe("deferred vendors", () => {
  it("pauses at a deferred vendor, carrying the fallback and credits spent so far", async () => {
    const a = stub("a", { outcome: "hit", value: "guess@acme.com", verified: false, creditsUsed: 1 });
    const d = stub("d", { outcome: "pending", requestId: "req-1" }, { deferred: true });
    const c = stub("c", { outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });

    const res = await runWaterfall("email", LEAD, envWith("a", "d", "c"), {
      order: ["a", "d", "c"],
      registry: [a, d, c],
      callbackUrl: "https://x.apps.clawnify.com/api/callbacks/d/tok",
    });

    expect(res.value).toBeNull();
    expect(res.pending).toEqual({
      providerId: "d",
      requestId: "req-1",
      position: 1,
      totalCredits: 1,
      fallback: { value: "guess@acme.com", providerId: "a" },
    });
    expect(c.calls).toBe(0); // nothing after the pause runs until the answer lands
    expect(res.attempts.map((x) => x.outcome)).toEqual(["hit", "pending"]);
  });

  it("skips a deferred vendor as an error, not a pause, when there is no callback URL", async () => {
    const d = stub("d", { outcome: "pending", requestId: "req-1" }, { deferred: true });
    const c = stub("c", { outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });

    const res = await runWaterfall("email", LEAD, envWith("d", "c"), { order: ["d", "c"], registry: [d, c] });

    expect(d.calls).toBe(0);
    expect(res.attempts[0]).toMatchObject({ providerId: "d", outcome: "error" });
    expect(res.value).toBe("ada@acme.com");
    expect(res.pending).toBeUndefined();
  });

  it("refuses a pending answer from a vendor that is not declared deferred", async () => {
    const bad = stub("bad", { outcome: "pending", requestId: "x" });
    const c = stub("c", { outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });

    const res = await runWaterfall("email", LEAD, envWith("bad", "c"), {
      order: ["bad", "c"],
      registry: [bad, c],
      callbackUrl: "https://x/cb",
    });

    expect(res.attempts[0]).toMatchObject({ providerId: "bad", outcome: "error" });
    expect(res.value).toBe("ada@acme.com");
  });

  it("finishes on a verified callback answer, caches it, and calls nothing further", async () => {
    const d = stub("d", { outcome: "pending" }, { deferred: true });
    const c = stub("c", { outcome: "hit", value: "wrong@acme.com", verified: true, creditsUsed: 1 });
    const store = new Map<string, { value: string; verified: boolean; providerId: string }>();
    const cache: EnrichCache = {
      get: async () => null,
      put: async (field, input, hit) => void store.set(cacheKey(field, input), hit),
    };

    const res = await applyDeferredResult(
      "email",
      LEAD,
      envWith("d", "c"),
      { providerId: "d", requestId: "req-1", position: 0, totalCredits: 0, fallback: null },
      { outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 2 },
      { order: ["d", "c"], registry: [d, c], cache },
    );

    expect(res).toMatchObject({ value: "ada@acme.com", providerId: "d", verified: true, totalCredits: 2 });
    expect(res.attempts).toEqual([{ providerId: "d", field: "email", outcome: "hit", creditsUsed: 2, ms: 0, detail: undefined }]);
    expect(c.calls).toBe(0);
    expect(store.get(cacheKey("email", LEAD))).toEqual({ value: "ada@acme.com", verified: true, providerId: "d" });
  });

  it("resumes from the next provider after a callback miss, keeping the earlier fallback", async () => {
    const d = stub("d", { outcome: "pending" }, { deferred: true });
    const c = stub("c", { outcome: "miss" });

    const res = await applyDeferredResult(
      "email",
      LEAD,
      envWith("d", "c"),
      { providerId: "d", requestId: "req-1", position: 0, totalCredits: 1, fallback: { value: "guess@acme.com", providerId: "a" } },
      { outcome: "miss", value: null, verified: false, creditsUsed: 0, detail: "No record" },
      { order: ["d", "c"], registry: [d, c] },
    );

    expect(c.calls).toBe(1);
    expect(d.calls).toBe(0); // the paused vendor is not asked again
    expect(res.attempts.map((x) => [x.providerId, x.outcome])).toEqual([["d", "miss"], ["c", "miss"]]);
    expect(res).toMatchObject({ value: "guess@acme.com", providerId: "a", verified: false, totalCredits: 1 });
  });

  it("can pause a second time when the resumed waterfall reaches another deferred vendor", async () => {
    const d1 = stub("d1", { outcome: "pending" }, { deferred: true });
    const d2 = stub("d2", { outcome: "pending", requestId: "req-2" }, { deferred: true });

    const res = await applyDeferredResult(
      "email",
      LEAD,
      envWith("d1", "d2"),
      { providerId: "d1", requestId: "req-1", position: 0, totalCredits: 0, fallback: null },
      { outcome: "miss", value: null, verified: false, creditsUsed: 1 },
      { order: ["d1", "d2"], registry: [d1, d2], callbackUrl: "https://x/cb2" },
    );

    expect(res.pending).toMatchObject({ providerId: "d2", requestId: "req-2", position: 1, totalCredits: 1 });
  });

  it("does not re-read the cache on resume, so a paused lookup cannot be answered by a stale entry", async () => {
    const c = stub("c", { outcome: "miss" });
    let reads = 0;
    const cache: EnrichCache = {
      get: async () => {
        reads++;
        return { value: "stale@acme.com", verified: true, providerId: "old" };
      },
      put: async () => {},
    };

    const res = await runWaterfall("email", LEAD, envWith("c"), {
      order: ["c"],
      registry: [c],
      cache,
      resume: { startAt: 0, totalCredits: 0, fallback: null },
    });

    expect(reads).toBe(0);
    expect(res.value).toBeNull();
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

// ── Alternative input requirements ──────────────────────────────────
//
// Several vendors accept "a profile URL OR an email" rather than a fixed set.
// An AND-only requirement list forced those adapters to either understate their
// needs (burning a call they cannot serve) or overstate them (never running at
// all) — which is what kept the phone waterfall permanently empty.

describe("requirement groups", () => {
  const ALT: InputRequirement = [["linkedinUrl", "email"]];

  it("runs the provider when any one alternative is present", async () => {
    for (const input of [
      { linkedinUrl: "https://www.linkedin.com/in/ada/" },
      { email: "ada@acme.com" },
    ]) {
      const a = stub("a", { outcome: "hit", value: "+15551234567", verified: true, creditsUsed: 5 }, {
        requires: ALT,
        fields: ["phone"],
      });
      const res = await runWaterfall("phone", input, envWith("a"), { order: ["a"], registry: [a] });
      expect(a.calls).toBe(1);
      expect(res.value).toBe("+15551234567");
    }
  });

  it("skips without spending when no alternative is present", async () => {
    const a = stub("a", { outcome: "hit", value: "+1555", verified: true, creditsUsed: 5 }, {
      requires: ALT,
      fields: ["phone"],
    });
    const res = await runWaterfall("phone", { fullName: "Ada Lovelace", domain: "acme.com" }, envWith("a"), {
      order: ["a"],
      registry: [a],
    });
    expect(a.calls).toBe(0);
    expect(res.attempts[0]).toMatchObject({ outcome: "ineligible", creditsUsed: 0 });
    expect(res.attempts[0].detail).toBe("Needs linkedinUrl or email");
  });

  it("still enforces every group, so a bare name is not enough", async () => {
    const a = stub("a", { outcome: "hit", value: "x", verified: true }, {
      requires: [
        ["linkedinUrl", "email", "fullName"],
        ["linkedinUrl", "email", "domain", "company"],
      ],
    });
    const res = await runWaterfall("email", { fullName: "Ada Lovelace" }, envWith("a"), {
      order: ["a"],
      registry: [a],
    });
    expect(a.calls).toBe(0);
    expect(res.attempts[0].outcome).toBe("ineligible");
  });

  it("renders an alternative group readably in the attempt log", () => {
    expect(describeRequirements([["linkedinUrl", "email"], "fullName"])).toBe("linkedinUrl or email, fullName");
  });
});

describe("normalization", () => {
  it("lowercases an email carried in as an input, so vendors get a canonical value", async () => {
    let seen: LeadInput | undefined;
    const a = stub("a", { outcome: "miss" }, { requires: [["email"]], fields: ["phone"] });
    a.find = async (_f, input) => {
      seen = input;
      return { outcome: "miss", value: null, verified: false, creditsUsed: 0 };
    };
    await runWaterfall("phone", { email: "  Ada@ACME.com " }, envWith("a"), { order: ["a"], registry: [a] });
    expect(seen?.email).toBe("ada@acme.com");
  });
});

describe("default order", () => {
  it("lists every shipped adapter for each field, so none is unreachable", () => {
    for (const field of ["email", "phone"] as const) {
      const order = defaultOrder(field);
      const able = REGISTRY.filter((p) => p.fields.includes(field)).map((p) => p.id);
      expect(new Set(order)).toEqual(new Set(able));
    }
  });

  it("names every id explicitly rather than relying on the trailing catch-all", () => {
    // The catch-all in defaultOrder() is a safety net for a newly added adapter.
    // If it is doing real work, the shipping default has drifted from intent.
    for (const field of ["email", "phone"] as const) {
      const able = REGISTRY.filter((p) => p.fields.includes(field)).map((p) => p.id);
      expect(able.filter((id) => !DEFAULT_ORDER[field].includes(id))).toEqual([]);
    }
  });

  it("puts the vendors that return pre-validated addresses first in the email waterfall", () => {
    const order = defaultOrder("email");
    expect(order.slice(0, 2)).toEqual(["findymail", "leadmagic"]);
  });
});
