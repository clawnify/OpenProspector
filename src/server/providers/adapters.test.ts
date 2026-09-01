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
import { AnymailFinderProvider } from "./anymailfinder";
import { ApolloProvider } from "./apollo";
import { BytemineProvider } from "./bytemine";
import { ContactOutProvider } from "./contactout";
import { DatagmaProvider } from "./datagma";
import { ForagerProvider } from "./forager";
import { HunterProvider } from "./hunter";
import { LeadMagicProvider } from "./leadmagic";
import { PeopleDataLabsProvider } from "./peopledatalabs";
import { ProspeoProvider } from "./prospeo";
import { SkrappProvider } from "./skrapp";
import { TombaProvider } from "./tomba";
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

describe("Hunter", () => {
  it("sends the key as a header rather than on the query string", async () => {
    stub([200, { data: { email: "ada@acme.com", score: 97, verification: { status: "valid" } } }]);
    const r = await HunterProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });
    expect(calls[0].headers["X-API-KEY"]).toBe("k");
    // A key on the query string leaks into logs and referrers.
    expect(calls[0].url).not.toContain("k");
    expect(calls[0].url).toContain("full_name=Ada+Lovelace");
    expect(calls[0].url).toContain("domain=acme.com");
  });

  it("keeps an accept_all address as an unverified fallback", async () => {
    stub([200, { data: { email: "ada@acme.com", verification: { status: "accept_all" } } }]);
    const r = await HunterProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", verified: false });
    expect(r.detail).toContain("accept_all");
  });

  it("charges nothing when there is no address", async () => {
    stub([200, { data: { email: null } }]);
    expect(await HunterProvider.find("email", LEAD, "k")).toMatchObject({ outcome: "miss", creditsUsed: 0 });
  });

  // The whole reason this adapter does not use the shared status mapping: for
  // Hunter a 429 is a spent monthly plan, not a transient rate limit, and
  // reporting it as a retryable error would hide why coverage collapsed.
  it("reads a 429 as an exhausted quota, not a rate limit", async () => {
    stub([429, {}]);
    const r = await HunterProvider.find("email", LEAD, "k");
    expect(r.outcome).toBe("no_credits");
    expect(r.detail).toContain("quota");
  });

  it("treats a data-subject withdrawal as a miss, not an error to retry", async () => {
    stub([451, { errors: [{ id: "claimed_email" }] }]);
    expect(await HunterProvider.find("email", LEAD, "k")).toMatchObject({ outcome: "miss", creditsUsed: 0 });
  });

  it("maps a rejected key to unconfigured", () => assertKeyRejectionIsUnconfigured(HunterProvider));
});

describe("Apollo", () => {
  it("puts match parameters on the query string, where Apollo reads them", async () => {
    stub([200, { person: { email: "ada@acme.com", email_status: "verified" } }]);
    const r = await ApolloProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["x-api-key"]).toBe("k");
    // Sending these as a JSON body is the silent failure: Apollo answers 200
    // having matched on nothing.
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].url).toContain("first_name=Ada");
    expect(calls[0].url).toContain("domain=acme.com");
  });

  it("never asks for a phone, because that answer would arrive by webhook", async () => {
    stub([200, { person: { email: "ada@acme.com", email_status: "verified" } }]);
    await ApolloProvider.find("email", LEAD, "k");
    expect(calls[0].url).not.toContain("reveal_phone_number");
    expect(calls[0].url).not.toContain("run_waterfall");
    expect(ApolloProvider.fields).toEqual(["email"]);
  });

  it("keeps a guessed address, but not as a verified one", async () => {
    stub([200, { person: { email: "ada@acme.com", email_status: "guessed" } }]);
    expect(await ApolloProvider.find("email", LEAD, "k")).toMatchObject({ outcome: "hit", verified: false });
  });

  it("refuses to hand back an address Apollo already knows bounces", async () => {
    stub([200, { person: { email: "ada@acme.com", email_status: "bounced" } }]);
    expect(await ApolloProvider.find("email", LEAD, "k")).toMatchObject({ outcome: "miss", value: null });
  });

  it("maps a rejected key to unconfigured", () => assertKeyRejectionIsUnconfigured(ApolloProvider));
});

describe("Anymail Finder", () => {
  it("sends the bare key, with no Bearer prefix", async () => {
    stub([200, { email: "ada@acme.com", email_status: "valid", credits_charged: 1 }]);
    const r = await AnymailFinderProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });
    expect(calls[0].headers.Authorization).toBe("k");
  });

  it("records the price the vendor reports, so a free re-search costs nothing", async () => {
    stub([200, { email: "ada@acme.com", email_status: "valid", credits_charged: 0 }]);
    expect(await AnymailFinderProvider.find("email", LEAD, "k")).toMatchObject({ outcome: "hit", creditsUsed: 0 });
  });

  it("keeps a risky address as an unverified fallback", async () => {
    stub([200, { email: "ada@acme.com", email_status: "risky", credits_charged: 0 }]);
    expect(await AnymailFinderProvider.find("email", LEAD, "k")).toMatchObject({ outcome: "hit", verified: false });
  });

  it("does not surface a suppressed address as contactable", async () => {
    stub([200, { email: "ada@acme.com", email_status: "blacklisted", credits_charged: 0 }]);
    expect(await AnymailFinderProvider.find("email", LEAD, "k")).toMatchObject({ outcome: "miss", value: null });
  });

  it("reads a 402 as out of credits", async () => {
    stub([402, {}]);
    expect(await AnymailFinderProvider.find("email", LEAD, "k")).toMatchObject({ outcome: "no_credits" });
  });

  it("maps a rejected key to unconfigured", () => assertKeyRejectionIsUnconfigured(AnymailFinderProvider));
});

describe("Tomba", () => {
  it("splits the compound secret across both auth headers", async () => {
    stub([200, { data: { email: "ada@acme.com", score: 92, verification: { status: "valid" } } }]);
    const r = await TombaProvider.find("email", LEAD, "ta_key:ts_secret");
    expect(r).toMatchObject({ outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });
    expect(calls[0].headers["X-Tomba-Key"]).toBe("ta_key");
    expect(calls[0].headers["X-Tomba-Secret"]).toBe("ts_secret");
  });

  it("says the key is malformed instead of spending a call to find out", async () => {
    stub([200, {}]);
    const r = await TombaProvider.find("email", LEAD, "just-the-key");
    expect(r.outcome).toBe("unconfigured");
    expect(r.detail).toContain("key:secret");
    expect(calls).toHaveLength(0);
  });

  it("declares its compound key shape so settings can show it", () => {
    expect(TombaProvider.keyFormat).toContain("key:secret");
  });

  it("treats an empty data object as a miss", async () => {
    stub([200, { data: {} }]);
    expect(await TombaProvider.find("email", LEAD, "a:b")).toMatchObject({ outcome: "miss", creditsUsed: 0 });
  });

  // Verified against the live API: Tomba answers a bad key with a 400, not a
  // 401, so mapping on status alone reports a wrong key as a broken vendor.
  it("reads a rejected key out of the 400 body, not the status", async () => {
    stub([400, { errors: { type: "authentication_failed", message: "Please enter a valid KEY.", code: 400 } }]);
    const r = await TombaProvider.find("email", LEAD, "a:b");
    expect(r).toMatchObject({ outcome: "unconfigured", creditsUsed: 0 });
    expect(r.detail).toContain("rejected the API key");
  });

  it("still reports a genuine 400 as an error", async () => {
    stub([400, { errors: { type: "invalid_parameter" } }]);
    expect(await TombaProvider.find("email", LEAD, "a:b")).toMatchObject({ outcome: "error" });
  });
});

describe("Skrapp", () => {
  it("splits a full name into the separate parameters Skrapp requires", async () => {
    stub([200, { email: "ada@acme.com", accuracy: 96, quality: { status: "valid", result: "deliverable" } }]);
    const r = await SkrappProvider.find("email", { fullName: "Ada Lovelace", domain: "acme.com" }, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });
    expect(calls[0].headers["X-Access-Key"]).toBe("k");
    expect(calls[0].url).toContain("firstName=Ada");
    expect(calls[0].url).toContain("lastName=Lovelace");
    // The finder is v2 even though the verifier is v3.
    expect(calls[0].url).toContain("/api/v2/find");
  });

  it("will not guess at a one-word name", async () => {
    stub([200, {}]);
    const r = await SkrappProvider.find("email", { fullName: "Ada", domain: "acme.com" }, "k");
    expect(r.outcome).toBe("ineligible");
    expect(calls).toHaveLength(0);
  });

  it("holds a valid-but-not-deliverable address as an unverified fallback", async () => {
    stub([200, { email: "ada@acme.com", quality: { status: "valid", result: "catch-all" } }]);
    expect(await SkrappProvider.find("email", LEAD, "k")).toMatchObject({ outcome: "hit", verified: false });
  });

  it("reads a 404 as a free miss", async () => {
    stub([404, {}]);
    expect(await SkrappProvider.find("email", LEAD, "k")).toMatchObject({ outcome: "miss", creditsUsed: 0 });
  });

  it("maps a rejected key to unconfigured", () => assertKeyRejectionIsUnconfigured(SkrappProvider));
});

describe("Datagma", () => {
  it("calls v8 of the finder, not the v6 its guide pages still show", async () => {
    stub([200, { email: "ada@acme.com", smtpCheck: true, mxfound: true, cachAll: false }]);
    const r = await DatagmaProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "ada@acme.com", verified: true, creditsUsed: 1 });
    expect(calls[0].url).toContain("/api/ingress/v8/findEmail");
    expect(calls[0].url).toContain("apiId=k");
  });

  it("never sends the person's profile URL as linkedInSlug, which means the company", async () => {
    stub([200, { email: "ada@acme.com", smtpCheck: true }]);
    await DatagmaProvider.find("email", LEAD, "k");
    expect(calls[0].url).not.toContain("linkedInSlug");
  });

  // `cachAll` is Datagma's own spelling. Reading the corrected name finds
  // nothing, and every catch-all guess is then billed as a verified mailbox.
  it("treats a catch-all guess as unverified and unbilled", async () => {
    stub([200, { email: "ada@acme.com", smtpCheck: true, cachAll: true }]);
    const r = await DatagmaProvider.find("email", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", verified: false, creditsUsed: 0 });
    expect(r.detail).toContain("Most probable");
  });

  it("prefers a mobile over a switchboard number and bills what creditBurn reports", async () => {
    stub([200, {
      phone: { mobiles: [{ value: "+15551234567" }], workPhones: [{ value: "+15550000000" }] },
      creditBurn: 30,
    }]);
    const r = await DatagmaProvider.find("phone", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "+15551234567", verified: true, creditsUsed: 30 });
    expect(calls[0].url).toContain("phoneFull=true");
  });

  it("falls back to a work number, but does not call it a direct line", async () => {
    stub([200, { phone: { mobiles: [], workPhones: [{ value: "+15550000000" }] }, creditBurn: 5 }]);
    const r = await DatagmaProvider.find("phone", LEAD, "k");
    expect(r).toMatchObject({ outcome: "hit", value: "+15550000000", verified: false, creditsUsed: 5 });
  });

  it("still records the spend when a phone lookup finds nothing", async () => {
    stub([200, { phone: { mobiles: [], workPhones: [] }, creditBurn: 2 }]);
    expect(await DatagmaProvider.find("phone", LEAD, "k")).toMatchObject({ outcome: "miss", creditsUsed: 2 });
  });

  it("reads the credit balance the gateway serialises as a string", async () => {
    stub([200, { currentCredit: "4200" }]);
    expect(await DatagmaProvider.credits!("k")).toMatchObject({ remaining: 4200 });
  });

  it("maps a rejected key to unconfigured", () => assertKeyRejectionIsUnconfigured(DatagmaProvider));
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
    HunterProvider,
    ApolloProvider,
    AnymailFinderProvider,
    TombaProvider,
    SkrappProvider,
    DatagmaProvider,
  ];

  // Forager (`accountId:key`) and Tomba (`key:secret`) take compound secrets;
  // everything else takes the key raw.
  const keyFor = (p: EnrichProvider) => (p.id === "forager" || p.id === "tomba" ? "1:k" : "k");

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
