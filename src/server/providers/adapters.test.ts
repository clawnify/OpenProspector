// Adapter tests.
//
// An adapter is a pure mapping from one vendor's response onto EnrichResult, so
// that mapping is exactly what is tested here, against a stubbed fetch. It is
// also the only thing that *can* be tested without a paid key at every vendor —
// and the part most likely to be wrong, because each vendor signals "found
// nothing", "your key is bad" and "you are out of credits" differently, and
// getting those three confused is what makes a waterfall silently stop
// resolving or silently keep spending.
//
// Each block asserts four things: a hit, a miss, an auth failure, and the
// eligibility gate that decides whether the vendor is called at all.

import { afterEach, describe, expect, it, vi } from "vitest";
import { BytemineProvider } from "./bytemine";
import { ContactOutProvider } from "./contactout";
import { ForagerProvider } from "./forager";
import { LeadMagicProvider } from "./leadmagic";
import { PeopleDataLabsProvider } from "./peopledatalabs";
import { ProspeoProvider } from "./prospeo";
import { POLL as WIZA_POLL, WizaProvider } from "./wiza";
import type { EnrichProvider } from "./types";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const calls: Call[] = [];

/** Stub fetch with a queue of `[status, body]` answers, in call order. */
function stub(...answers: [number, unknown][]) {
  calls.length = 0;
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const [status, body] = answers[Math.min(i++, answers.length - 1)];
    return {
      status,
      json: async () => {
        if (body === undefined) throw new Error("not json");
        return body;
      },
    } as Response;
  });
}

// Exercise Wiza's real poll loop without sleeping through its real schedule.
WIZA_POLL.firstPollMs = 0;
WIZA_POLL.intervalMs = 0;

afterEach(() => vi.unstubAllGlobals());

const LEAD = {
  fullName: "Ada Lovelace",
  firstName: "Ada",
  lastName: "Lovelace",
  domain: "acme.com",
  company: "Acme",
  linkedinUrl: "https://www.linkedin.com/in/ada-lovelace/",
};

/** Every adapter must map a rejected key onto `unconfigured`, never `error`. */
async function assertKeyRejectionIsUnconfigured(p: EnrichProvider, status = 401) {
  stub([status, { error: true, error_code: "INVALID_API_KEY" }]);
  const r = await p.find(p.fields[0], LEAD, "bad-key");
  expect(r.outcome).toBe("unconfigured");
  expect(r.creditsUsed).toBe(0);
}

describe("LeadMagic", () => {
  it("authenticates with X-API-Key and stops on a valid email", async () => {
    stub([200, { email: "ada@acme.com", status: "valid", credits_consumed: 1 }]);
    const r = await LeadMagicProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });
    expect(calls[0].url).toBe("https://api.leadmagic.io/v1/people/email-finder");
    expect(calls[0].headers["X-API-Key"]).toBe("k");
  });

  it("charges nothing for a null-status result", async () => {
    stub([200, { email: null, status: null, credits_consumed: 0, message: "No email found." }]);
    const r = await LeadMagicProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "miss", value: null, creditsUsed: 0 });
  });

  it("records the mobile price the vendor actually reports, not the list price", async () => {
    stub([200, { mobile_number: "+15551234567", credits_consumed: 5 }]);
    const r = await LeadMagicProvider.find("phone", { ...LEAD, email: "ada@acme.com" }, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "+15551234567", verified: true, creditsUsed: 5 });
    // The mobile endpoint takes no name or domain — only the identifiers.
    expect(calls[0].body).toEqual({ profile_url: LEAD.linkedinUrl, work_email: "ada@acme.com" });
  });

  it("needs a profile URL or an email before it will look for a mobile", () => {
    expect(LeadMagicProvider.requirements("phone")).toEqual([["linkedinUrl", "email"]]);
  });

  it("maps a rejected key to unconfigured", () => assertKeyRejectionIsUnconfigured(LeadMagicProvider));
});

describe("Wiza", () => {
  it("polls the reveal to completion and returns the graded email", async () => {
    stub(
      [200, { data: { id: 32, status: "queued", is_complete: false } }],
      [200, {
        data: {
          id: 32,
          status: "finished",
          is_complete: true,
          email: "ada@acme.com",
          email_status: "valid",
          credits: { api_credits: { total: 2 } },
        },
      }],
    );
    const r = await WizaProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 2 });
    expect(calls[0].body).toMatchObject({ enrichment_level: "partial" });
    expect(calls[1].url).toBe("https://wiza.co/api/individual_reveals/32");
  });

  it("keeps a catch-all address as an unverified fallback rather than stopping on it", async () => {
    stub([200, { data: { id: 7 } }], [200, { data: { is_complete: true, status: "finished", email: "ada@acme.com", email_status: "catch_all" } }]);
    const r = await WizaProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", verified: false });
    expect(r.detail).toContain("catch_all");
  });

  it("asks only for phones when resolving a phone, so it cannot bill for an email too", async () => {
    stub([200, { data: { id: 9 } }], [200, { data: { is_complete: true, status: "finished", mobile_phone: "+15551234567", credits: { api_credits: { total: 5 } } } }]);
    const r = await WizaProvider.find("phone", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "+15551234567", creditsUsed: 5 });
    expect(calls[0].body).toMatchObject({ enrichment_level: "phone" });
  });

  it("maps a rejected key to unconfigured", () => assertKeyRejectionIsUnconfigured(WizaProvider));
});

describe("People Data Labs", () => {
  it("sets required= so a match with no email is not billed", async () => {
    stub([200, { status: 200, likelihood: 9, data: { work_email: "ada@acme.com" } }]);
    const r = await PeopleDataLabsProvider.find("email", { fullName: "Ada Lovelace", domain: "acme.com" }, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "ada@acme.com", creditsUsed: 1 });
    // Never a stopping hit: PDL asserts no deliverability.
    expect(r.verified).toBe(false);
    expect(calls[0].url).toContain("required=work_email");
    expect(calls[0].url).toContain("min_likelihood=6");
    expect(calls[0].headers["X-Api-Key"]).toBe("k");
  });

  it("never returns a historical address from emails[]", async () => {
    stub([200, { data: { work_email: null, emails: [{ address: "ada@previous-job.com", type: "current_professional" }] } }]);
    const r = await PeopleDataLabsProvider.find("email", LEAD, "k");
    expect(r.outcome).toBe("miss");
    expect(r.value).toBeNull();
  });

  it("treats a 404 as a free miss", async () => {
    stub([404, { status: 404, error: { type: "not_found" } }]);
    const r = await PeopleDataLabsProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "miss", creditsUsed: 0 });
  });

  it("reports account exhaustion as no_credits, not a generic error", async () => {
    stub([402, { status: 402, error: { type: "payment_required" } }]);
    const r = await PeopleDataLabsProvider.find("email", LEAD, "k");
    expect(r.outcome).toBe("no_credits");
  });

  it("prefers the validated mobile source over the catch-all list", async () => {
    stub([200, { data: { mobile_phone: "+15550001111", phone_numbers: ["+15559998888"] } }]);
    const r = await PeopleDataLabsProvider.find("phone", LEAD, "k");
    expect(r).toMatchObject({ value: "+15550001111", verified: true });
  });

  it("maps a rejected key to unconfigured", () => assertKeyRejectionIsUnconfigured(PeopleDataLabsProvider));
});

describe("Prospeo", () => {
  it("refuses a masked value even though the payload carries one", async () => {
    stub([200, { error: false, person: { email: { status: "VERIFIED", revealed: false, email: "ada.*****@acme.com" } } }]);
    const r = await ProspeoProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "miss", value: null });
  });

  it("returns a revealed, verified address for one credit", async () => {
    stub([200, { error: false, free_enrichment: false, person: { email: { status: "VERIFIED", revealed: true, email: "ada@acme.com" } } }]);
    const r = await ProspeoProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });
    expect(calls[0].headers["X-KEY"]).toBe("k");
    expect(calls[0].body).toMatchObject({ only_verified_email: true });
  });

  it("charges nothing for a free re-enrichment inside the 90-day window", async () => {
    stub([200, { error: false, free_enrichment: true, person: { email: { status: "VERIFIED", revealed: true, email: "ada@acme.com" } } }]);
    const r = await ProspeoProvider.find("email", LEAD, "k");
    expect(r.creditsUsed).toBe(0);
  });

  it("asks for a mobile only where one exists, at the documented 10 credits", async () => {
    stub([200, { error: false, person: { mobile: { status: "VERIFIED", revealed: true, mobile: "+15551234567" } } }]);
    const r = await ProspeoProvider.find("phone", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "+15551234567", creditsUsed: 10 });
    expect(calls[0].body).toMatchObject({ enrich_mobile: true, only_verified_mobile: true });
  });

  it("distinguishes NO_MATCH from a bad key, though both arrive as HTTP 400", async () => {
    stub([400, { error: true, error_code: "NO_MATCH" }]);
    expect((await ProspeoProvider.find("email", LEAD, "k")).outcome).toBe("miss");

    stub([400, { error: true, error_code: "INSUFFICIENT_CREDITS" }]);
    expect((await ProspeoProvider.find("email", LEAD, "k")).outcome).toBe("no_credits");

    stub([400, { error: true, error_code: "INVALID_API_KEY" }]);
    expect((await ProspeoProvider.find("email", LEAD, "k")).outcome).toBe("unconfigured");
  });
});

describe("ContactOut", () => {
  it("asks for only the field being resolved, so it bills one pool not two", async () => {
    stub([200, { status_code: 200, profile: { work_email: ["ada@acme.com"], work_email_status: { "ada@acme.com": "Verified" } } }]);
    const r = await ContactOutProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "ada@acme.com", verified: true });
    expect(calls[0].headers.token).toBe("k");
    expect(calls[0].body).toMatchObject({ include: ["work_email"] });
  });

  it("does not stop the waterfall on an address it has not marked Verified", async () => {
    stub([200, { profile: { work_email: ["ada@acme.com"], work_email_status: { "ada@acme.com": "Unverified" } } }]);
    expect((await ContactOutProvider.find("email", LEAD, "k")).verified).toBe(false);
  });

  it("sends company handles as arrays, which is what the endpoint expects", async () => {
    stub([200, { profile: {} }]);
    await ContactOutProvider.find("email", { fullName: "Ada Lovelace", domain: "acme.com" }, "k");
    expect(calls[0].body).toMatchObject({ company_domain: ["acme.com"] });
  });

  it("maps a rejected key to unconfigured", () => assertKeyRejectionIsUnconfigured(ContactOutProvider));
});

describe("Forager", () => {
  it("splits the compound secret and keys on the LinkedIn slug", async () => {
    stub([200, [{ phone_number: "+15551234567" }]]);
    const r = await ForagerProvider.find("phone", LEAD, "4242:secret-key");
    expect(r).toMatchObject({ outcome: "hit", value: "+15551234567", verified: true });
    expect(calls[0].url).toBe(
      "https://api-v2.forager.ai/api/4242/datastorage/person_contacts_lookup/phone_numbers/",
    );
    expect(calls[0].headers["X-API-KEY"]).toBe("secret-key");
    expect(calls[0].body).toEqual({ linkedin_public_identifier: "ada-lovelace" });
  });

  it("reports a malformed compound secret as a configuration problem, not a vendor error", async () => {
    stub([200, []]);
    const r = await ForagerProvider.find("phone", LEAD, "just-a-key");
    expect(r.outcome).toBe("unconfigured");
    expect(r.detail).toContain("accountId:apiKey");
    expect(calls).toHaveLength(0);
  });

  it("skips a lead with no LinkedIn URL without spending", async () => {
    stub([200, []]);
    const r = await ForagerProvider.find("phone", { fullName: "Ada Lovelace", domain: "acme.com" }, "1:k");
    expect(r.outcome).toBe("ineligible");
    expect(calls).toHaveLength(0);
  });

  it("drops an address the vendor already graded invalid", async () => {
    stub([200, [{ email: "ada@acme.com", email_type: "work", validation_status: "invalid" }]]);
    const r = await ForagerProvider.find("email", LEAD, "1:k");
    expect(r).toMatchObject({ outcome: "miss", value: null });
  });
});

describe("Bytemine", () => {
  it("uses the base URL and header from the published spec, not the marketing snippet", async () => {
    stub([200, { mobile: "+15551234567" }]);
    const r = await BytemineProvider.find("phone", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "+15551234567" });
    expect(calls[0].url).toBe("https://api.bytemine.ai/v1/enrich/mobile");
    expect(calls[0].headers["x-api-key"]).toBe("k");
  });

  it("resolves an email only through the LinkedIn endpoint", async () => {
    stub([200, { work_email: "ada@acme.com", verified_at: "2026-01-01T00:00:00Z" }]);
    const r = await BytemineProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "ada@acme.com", verified: true });
    expect(calls[0].url).toBe("https://api.bytemine.ai/v1/enrich/linkedin");
  });

  it("will not attempt an email without a LinkedIn URL", async () => {
    stub([200, {}]);
    const r = await BytemineProvider.find("email", { fullName: "Ada Lovelace", domain: "acme.com" }, "k");
    expect(r.outcome).toBe("ineligible");
    expect(calls).toHaveLength(0);
  });

  it("splits a single sourced full name, since the schema has no full_name field", async () => {
    stub([200, { mobile: "+15551234567" }]);
    await BytemineProvider.find("phone", { fullName: "Ada Lovelace", domain: "acme.com" }, "k");
    expect(calls[0].body).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      company_domain: "acme.com",
    });
  });

  it("prefers a mobile over a direct dial", async () => {
    stub([200, { mobile: "+15550001111", direct_dial: "+15559998888" }]);
    expect((await BytemineProvider.find("phone", LEAD, "k")).value).toBe("+15550001111");
  });

  it("maps a rejected key to unconfigured", () => assertKeyRejectionIsUnconfigured(BytemineProvider));
});

describe("every adapter", () => {
  const ALL = [
    LeadMagicProvider,
    WizaProvider,
    PeopleDataLabsProvider,
    ProspeoProvider,
    ContactOutProvider,
    ForagerProvider,
    BytemineProvider,
  ];

  // Forager's key is compound (`accountId:key`); everything else takes it raw.
  const keyFor = (p: EnrichProvider) => (p.id === "forager" ? "1:k" : "k");

  it("survives a vendor answering with HTML instead of JSON", async () => {
    for (const p of ALL) {
      stub([500, undefined]);
      const r = await p.find(p.fields[0], LEAD, keyFor(p));
      expect(r.outcome, p.id).toBe("error");
      expect(r.value, p.id).toBeNull();
      expect(r.creditsUsed, p.id).toBe(0);
    }
  });

  it("never throws, whatever the vendor returns", async () => {
    for (const p of ALL) {
      stub([200, { unexpected: "shape" }]);
      await expect(p.find(p.fields[0], LEAD, keyFor(p)), p.id).resolves.toBeDefined();
    }
  });
});
