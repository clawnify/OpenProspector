// Company adapter tests.
//
// Same job as adapters.test.ts, for the other subject: a company adapter is a
// pure mapping from one vendor's response onto CompanyResult, and that mapping
// is what is tested here against a stubbed fetch.
//
// It carries more weight than its person-side sibling, because eleven of the
// fourteen adapters could not be checked against a real key. For those, the
// response fixtures below are transcribed from each vendor's published contract
// and the *nesting* is the whole point: `address.city` vs `city`,
// `links.linkedin` vs `linkedin_url`, `search_results` vs `results`. Every one
// of those compiles, typechecks, and silently returns a row of undefineds if it
// is wrong — which is a blank export nobody notices until the audience upload
// is rejected.
//
// Three vendors DID have a real key on 2026-09-03, and their fixtures are the
// live responses verbatim: Findymail, Wiza, Prospeo. Those are marked.
//
// Each block asserts a hit's field mapping, a miss, and a rejected key.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApolloCompanyProvider } from "./apollo";
import { ContactOutCompanyProvider } from "./contactout";
import { DatagmaCompanyProvider } from "./datagma";
import { FindymailCompanyProvider } from "./findymail";
import { ForagerCompanyProvider } from "./forager";
import { HunterCompanyProvider } from "./hunter";
import { LeadMagicCompanyProvider } from "./leadmagic";
import { PeopleDataLabsCompanyProvider } from "./peopledatalabs";
import { ProspeoCompanyProvider } from "./prospeo";
import { RocketReachCompanyProvider } from "./rocketreach";
import { SnovCompanyProvider } from "./snov";
import { SurfeCompanyProvider } from "./surfe";
import { TombaCompanyProvider } from "./tomba";
import { WizaCompanyProvider } from "./wiza";
import { COMPANY_REGISTRY } from "./company";
import { POLL } from "./vendor";
import type { CompanyProvider } from "./types";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const calls: Call[] = [];

function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

/** Stub fetch with a queue of `[status, body]` answers, in call order. */
function stub(...answers: [number, unknown][]) {
  calls.length = 0;
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? parseBody(String(init.body)) : undefined,
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

// Exercise the real poll loops without sleeping through their real schedules.
POLL.firstPollMs = 0;
POLL.intervalMs = 0;

afterEach(() => vi.unstubAllGlobals());

/** A compound-secret vendor still needs a well-formed value to get past its own parsing. */
function key(p: CompanyProvider): string {
  return p.keyFormat ? "1:bogus-key" : "bogus-key";
}

describe("Apollo (company)", () => {
  it("maps the organization envelope", async () => {
    stub([200, {
      organization: {
        name: "Stripe",
        linkedin_url: "http://www.linkedin.com/company/stripe",
        industry: "internet",
        city: "South San Francisco",
        state: "California",
        postal_code: "94080",
        country: "United States",
        estimated_num_employees: 15928,
        founded_year: 2010,
        publicly_traded_symbol: null,
      },
    }]);
    const r = await ApolloCompanyProvider.enrich("stripe.com", "k");
    expect(r.outcome).toBe("hit");
    expect(r.creditsUsed).toBe(1);
    expect(r.data).toEqual({
      name: "Stripe",
      linkedinUrl: "https://www.linkedin.com/company/stripe",
      industry: "internet",
      city: "South San Francisco",
      state: "California",
      postalCode: "94080",
      country: "United States",
      employeeCount: 15928,
      foundedYear: 2010,
      stockSymbol: undefined,
    });
  });

  it("treats a missing organization as a free miss", async () => {
    stub([200, { organization: null }]);
    const r = await ApolloCompanyProvider.enrich("nowhere.example", "k");
    expect(r.outcome).toBe("miss");
    expect(r.creditsUsed).toBe(0);
  });
});

describe("Hunter (company)", () => {
  it("maps category / geo / linkedin.handle, which is a bare handle", async () => {
    stub([200, {
      data: {
        name: "Stripe",
        ticker: "XYZ",
        foundedYear: 2010,
        category: { industry: "Internet Software & Services" },
        geo: { city: "San Francisco", state: "California", postalCode: "94103", country: "US" },
        linkedin: { handle: "company/stripe" },
        metrics: { employeesCount: 7000 },
      },
    }]);
    const r = await HunterCompanyProvider.enrich("stripe.com", "k");
    expect(r.data).toMatchObject({
      industry: "Internet Software & Services",
      // The handle is not a URL; shipping it unchanged breaks the upload column.
      linkedinUrl: "https://www.linkedin.com/company/stripe",
      city: "San Francisco",
      postalCode: "94103",
      stockSymbol: "XYZ",
      employeeCount: 7000,
    });
  });

  it("reports an exhausted monthly quota as no_credits, not a rate limit", async () => {
    stub([429, { errors: [{ id: "usage_exceeded" }] }]);
    const r = await HunterCompanyProvider.enrich("stripe.com", "k");
    expect(r.outcome).toBe("no_credits");
  });
});

describe("People Data Labs (company)", () => {
  it("reads the record flat at the root, not under `data`", async () => {
    // The person endpoint nests under `data` and this one does not. Reading
    // `body.data` here yields undefined for every field.
    stub([200, {
      display_name: "Stripe",
      name: "stripe",
      industry: "internet",
      ticker: null,
      linkedin_url: "linkedin.com/company/stripe",
      employee_count: 15928,
      founded: 2010,
      location: { locality: "South San Francisco", region: "California", country: "United States", postal_code: "94080" },
    }]);
    const r = await PeopleDataLabsCompanyProvider.enrich("stripe.com", "k");
    expect(r.data).toMatchObject({
      // display_name, not the lowercased `name`.
      name: "Stripe",
      // The vendor's value carries no scheme.
      linkedinUrl: "https://www.linkedin.com/company/stripe",
      city: "South San Francisco",
      postalCode: "94080",
    });
  });

  it("treats a 404 as a free miss, because PDL bills per match", async () => {
    stub([404, { error: { message: "No records found" } }]);
    const r = await PeopleDataLabsCompanyProvider.enrich("nowhere.example", "k");
    expect(r.outcome).toBe("miss");
    expect(r.creditsUsed).toBe(0);
  });
});

describe("Wiza (company)", () => {
  // Fixture is a LIVE response (real key, stripe.com, 2026-09-03), trimmed.
  const LIVE = {
    status: { code: 200, message: "Company data enriched successfully" },
    type: "company_enrichment",
    data: {
      company_industry: "Technology, Information and Internet",
      company_size: 16850,
      company_size_range: "5001-10000",
      company_founded: 2010,
      company_ticker: null,
      company_linkedin: "https://www.linkedin.com/company/stripe",
      company_locality: "South san francisco",
      company_region: "California",
      company_postal_code: "94080",
      company_country: "United states",
      company_name: "Stripe",
      credits: { api_credits: { company_credits: 2, total: 2 } },
    },
  };

  it("maps the live response and records what Wiza said it charged", async () => {
    stub([200, LIVE]);
    const r = await WizaCompanyProvider.enrich("stripe.com", "k");
    expect(r.creditsUsed).toBe(2);
    expect(r.data).toMatchObject({
      name: "Stripe",
      industry: "Technology, Information and Internet",
      linkedinUrl: "https://www.linkedin.com/company/stripe",
      // The integer, never the "5001-10000" bucket — the column is an INTEGER.
      employeeCount: 16850,
      city: "South san francisco",
      postalCode: "94080",
    });
  });

  it("does not put the bucketed range in the headcount column", async () => {
    stub([200, { data: { ...LIVE.data, company_size: null } }]);
    const r = await WizaCompanyProvider.enrich("stripe.com", "k");
    expect(r.data?.employeeCount).toBeUndefined();
  });

  it("treats a 404 as a free miss", async () => {
    stub([404, { status: { code: 404, message: "Company not found" } }]);
    const r = await WizaCompanyProvider.enrich("nowhere.example", "k");
    expect(r.outcome).toBe("miss");
    expect(r.creditsUsed).toBe(0);
  });
});

describe("Prospeo (company)", () => {
  // Fixture is a LIVE response (real key, stripe.com, 2026-09-03), trimmed.
  it("maps the live response", async () => {
    stub([200, {
      error: false,
      free_enrichment: false,
      company: {
        name: "Stripe",
        industry: "Technology, Information and Internet",
        employee_count: 15928,
        employee_range: "10000+",
        location: { country: "United States", country_code: "US", state: "California", city: "South San Francisco", raw_address: "354 Oyster Point Blvd, South San Francisco, California 94080, US" },
        linkedin_url: "https://www.linkedin.com/company/stripe",
        founded: 2010,
      },
    }]);
    const r = await ProspeoCompanyProvider.enrich("stripe.com", "k");
    expect(r.creditsUsed).toBe(1);
    expect(r.data).toEqual({
      name: "Stripe",
      industry: "Technology, Information and Internet",
      linkedinUrl: "https://www.linkedin.com/company/stripe",
      employeeCount: 15928,
      foundedYear: 2010,
      city: "South San Francisco",
      state: "California",
      country: "United States",
    });
    // The zipcode is visible inside raw_address and deliberately not scraped.
    expect(r.data).not.toHaveProperty("postalCode");
  });

  it("charges nothing for a re-enrichment the vendor calls free", async () => {
    stub([200, { error: false, free_enrichment: true, company: { name: "Stripe" } }]);
    const r = await ProspeoCompanyProvider.enrich("stripe.com", "k");
    expect(r.creditsUsed).toBe(0);
  });

  it("reads error_code, not the status: NO_MATCH is a 400 and a miss", async () => {
    stub([400, { error: true, error_code: "NO_MATCH" }]);
    const r = await ProspeoCompanyProvider.enrich("nowhere.example", "k");
    expect(r.outcome).toBe("miss");
    expect(r.creditsUsed).toBe(0);
  });
});

describe("RocketReach (company)", () => {
  it("reads the nested address and links objects", async () => {
    // Both nestings come from RocketReach's OpenAPI definition. Reading either
    // flat compiles and returns undefined for every location column.
    stub([200, {
      name: "Stripe",
      industry: "Internet",
      num_employees: 7000,
      year_founded: 2010,
      ticker_symbol: "XYZ",
      links: { linkedin: "https://www.linkedin.com/company/stripe" },
      address: { city: "San Francisco", region: "California", postal_code: "94103", country: "United States" },
    }]);
    const r = await RocketReachCompanyProvider.enrich("stripe.com", "k");
    expect(r.data).toMatchObject({
      linkedinUrl: "https://www.linkedin.com/company/stripe",
      city: "San Francisco",
      state: "California",
      postalCode: "94103",
      stockSymbol: "XYZ",
    });
  });

  it("treats a 404 as a free miss", async () => {
    stub([404, { detail: "Not found" }]);
    const r = await RocketReachCompanyProvider.enrich("nowhere.example", "k");
    expect(r.outcome).toBe("miss");
    expect(r.creditsUsed).toBe(0);
  });
});

describe("LeadMagic (company)", () => {
  it("reads the LinkedIn page from b2b_profile_url, which is what it is called", async () => {
    stub([200, {
      companyName: "Stripe",
      industry: "Internet",
      employeeCount: 7000,
      employeeRange: "5001-10000",
      founded: 2010,
      headquarters: { city: "San Francisco", state: "California", country: "United States" },
      b2b_profile_url: "https://www.linkedin.com/company/stripe",
    }]);
    const r = await LeadMagicCompanyProvider.enrich("stripe.com", "k");
    expect(r.data).toMatchObject({
      name: "Stripe",
      linkedinUrl: "https://www.linkedin.com/company/stripe",
      city: "San Francisco",
      employeeCount: 7000,
    });
  });

  it("treats a 200 with no company as a free miss", async () => {
    // Documented as "Company not found" at no cost, so recording a credit here
    // would overstate every fruitless run.
    stub([200, { message: "Company not found" }]);
    const r = await LeadMagicCompanyProvider.enrich("nowhere.example", "k");
    expect(r.outcome).toBe("miss");
    expect(r.creditsUsed).toBe(0);
  });
});

describe("Tomba (company)", () => {
  it("builds a page URL from the bare vanity Tomba returns", async () => {
    stub([200, {
      data: {
        organization: "Tomba",
        website: "https://tomba.io",
        country: "US",
        state: "California",
        city: "San Francisco",
        postal_code: "94105",
        employees: "11-50",
        founded: 2018,
        industry: "Computer Software",
        linkedin: "tomba",
      },
    }]);
    const r = await TombaCompanyProvider.enrich("tomba.io", "k:s");
    expect(r.data).toMatchObject({
      name: "Tomba",
      industry: "Computer Software",
      linkedinUrl: "https://www.linkedin.com/company/tomba",
      city: "San Francisco",
      postalCode: "94105",
    });
    // `employees` is a range, so it must not reach the INTEGER column.
    expect(r.data?.employeeCount).toBeUndefined();
  });

  it("also accepts the other spelling its docs use", async () => {
    // Tomba documents this response two ways and there is no key to settle it;
    // both are read on purpose. See the adapter header.
    stub([200, { data: { organization: "Tomba", industries: ["Computer Software"], linkedin_url: "https://www.linkedin.com/company/tomba" } }]);
    const r = await TombaCompanyProvider.enrich("tomba.io", "k:s");
    expect(r.data).toMatchObject({ industry: "Computer Software", linkedinUrl: "https://www.linkedin.com/company/tomba" });
  });

  it("reads a rejected key out of the body, because Tomba sends it as a 400", async () => {
    stub([400, { errors: { type: "authentication_failed", message: "Please enter a valid KEY." } }]);
    const r = await TombaCompanyProvider.enrich("tomba.io", "k:s");
    expect(r.outcome).toBe("unconfigured");
  });

  it("refuses a secret that is not key:secret without calling the vendor", async () => {
    stub([200, {}]);
    const r = await TombaCompanyProvider.enrich("tomba.io", "just-a-key");
    expect(r.outcome).toBe("unconfigured");
    expect(calls).toHaveLength(0);
  });
});

describe("ContactOut (company)", () => {
  it("sends a one-element array and reads the map back by domain", async () => {
    stub([200, {
      status_code: 200,
      companies: {
        "stripe.com": { name: "Stripe", li_vanity: "stripe", country: "United States", size: "1001-5000", founded_at: 2010, industry: "Internet", employees: 7000 },
      },
    }]);
    const r = await ContactOutCompanyProvider.enrich("stripe.com", "k");
    expect(calls[0].body).toEqual({ domains: ["stripe.com"] });
    expect(r.data).toMatchObject({
      name: "Stripe",
      // li_vanity is a bare vanity, not a URL.
      linkedinUrl: "https://www.linkedin.com/company/stripe",
      country: "United States",
      foundedYear: 2010,
      employeeCount: 7000,
    });
  });

  it("treats a response with no entry for the domain as a miss", async () => {
    stub([200, { status_code: 200, companies: {} }]);
    const r = await ContactOutCompanyProvider.enrich("nowhere.example", "k");
    expect(r.outcome).toBe("miss");
  });
});

describe("Datagma (company)", () => {
  it("merges basic and premium and records the vendor's own creditBurn", async () => {
    stub([200, {
      company: {
        basic: { name: "Algolia", website: "algolia.com", yearFounded: 2012, industry: "Software", locality: "Paris", region: "IDF", country: "FR", linkedUrl: "https://www.linkedin.com/company/algolia" },
        premium: { name: "Algolia SAS", headquaterAddrPostalCode: "75002" },
      },
      creditBurn: 3,
    }]);
    const r = await DatagmaCompanyProvider.enrich("algolia.com", "k");
    expect(r.creditsUsed).toBe(3);
    expect(r.data).toMatchObject({
      name: "Algolia",
      industry: "Software",
      linkedinUrl: "https://www.linkedin.com/company/algolia",
      city: "Paris",
      // Datagma's own spelling, and the only block carrying the postal code.
      postalCode: "75002",
    });
  });

  it("asks for the premium block but not the priced financial one", async () => {
    stub([200, { company: { basic: { name: "Algolia" } } }]);
    await DatagmaCompanyProvider.enrich("algolia.com", "k");
    expect(calls[0].url).toContain("companyPremium=true");
    expect(calls[0].url).not.toContain("companyFull");
  });

  it("treats a response with no company name as a miss", async () => {
    stub([200, { company: {} }]);
    const r = await DatagmaCompanyProvider.enrich("nowhere.example", "k");
    expect(r.outcome).toBe("miss");
  });
});

describe("Forager (company)", () => {
  const RESULT = {
    search_results: [{
      name: "Stripe",
      legal_name: "Stripe, Inc.",
      founded_date: "2010-09-01",
      employees_amount: 7000,
      linkedin_info: { public_profile_url: "https://www.linkedin.com/company/stripe", industry: { id: 4, name: "Internet" } },
      addresses: [{ city: "San Francisco", state: "California", postcode: "94103", country: "United States" }],
    }],
    total_search_results: 1,
  };

  it("reads search_results, the industry object and the addresses array", async () => {
    stub([200, RESULT]);
    const r = await ForagerCompanyProvider.enrich("stripe.com", "1:key");
    expect(calls[0].body).toEqual({ domains: ["stripe.com"] });
    expect(r.data).toMatchObject({
      name: "Stripe",
      // An object with a name, not a string.
      industry: "Internet",
      linkedinUrl: "https://www.linkedin.com/company/stripe",
      city: "San Francisco",
      // Forager spells it `postcode`.
      postalCode: "94103",
      // Sliced out of a full date.
      foundedYear: 2010,
    });
  });

  it("treats an empty result set as a miss", async () => {
    stub([200, { search_results: [], total_search_results: 0 }]);
    const r = await ForagerCompanyProvider.enrich("nowhere.example", "1:key");
    expect(r.outcome).toBe("miss");
  });

  it("refuses a secret that is not accountId:apiKey without calling the vendor", async () => {
    stub([200, RESULT]);
    const r = await ForagerCompanyProvider.enrich("stripe.com", "just-a-key");
    expect(r.outcome).toBe("unconfigured");
    expect(calls).toHaveLength(0);
  });
});

describe("Findymail (company)", () => {
  // Fixture is a LIVE response (real key, stripe.com, 2026-09-03).
  it("maps the location fields the published schema omits", async () => {
    stub([200, {
      name: "Stripe",
      domain: "stripe.com",
      company_size: "5001-10000",
      industry: "Computer Software",
      linkedin_url: "https://www.linkedin.com/company/stripe/",
      description: "Stripe builds programmable financial services.",
      city: "South San Francisco",
      region: "California",
      country: "us",
    }]);
    const r = await FindymailCompanyProvider.enrich("stripe.com", "k");
    expect(r.creditsUsed).toBe(1);
    expect(r.data).toEqual({
      name: "Stripe",
      industry: "Computer Software",
      linkedinUrl: "https://www.linkedin.com/company/stripe",
      city: "South San Francisco",
      state: "California",
      // Upper-cased for the LinkedIn `companycountry` column.
      country: "US",
    });
  });

  it("treats a 404 as a free miss", async () => {
    stub([404, { message: "Not Found" }]);
    const r = await FindymailCompanyProvider.enrich("nowhere.example", "k");
    expect(r.outcome).toBe("miss");
    expect(r.creditsUsed).toBe(0);
  });
});

describe("Surfe (company)", () => {
  it("polls the enrichment and maps the first company", async () => {
    stub(
      [202, { enrichmentID: "abc" }],
      [200, {
        status: "COMPLETED",
        companies: [{
          name: "Stripe",
          websites: ["stripe.com"],
          linkedInURL: "https://www.linkedin.com/company/stripe",
          industry: "Internet",
          employeeCount: 7000,
          founded: "2010",
          hqAddress: "354 Oyster Point Blvd, South San Francisco, California",
          hqCountry: "United States",
          stocks: [{ exchange: "NYSE", ticker: "XYZ" }],
        }],
      }],
    );
    const r = await SurfeCompanyProvider.enrich("stripe.com", "k");
    expect(r.data).toMatchObject({
      name: "Stripe",
      linkedinUrl: "https://www.linkedin.com/company/stripe",
      stockSymbol: "XYZ",
      // `founded` is a string here and a number everywhere else.
      foundedYear: 2010,
      country: "United States",
    });
    // hqAddress is one free-text line; splitting it into a city would be a guess.
    expect(r.data?.city).toBeUndefined();
  });

  it("reports a spent quota, which Surfe sends as a 403", async () => {
    stub([403, {}]);
    const r = await SurfeCompanyProvider.enrich("stripe.com", "k");
    expect(r.outcome).toBe("no_credits");
  });
});

describe("Snov.io (company)", () => {
  const TOKEN: [number, unknown] = [200, { access_token: "t", expires_in: 3600 }];
  // Snov mints a bearer from the client credentials and caches it per clientId
  // for the token's lifetime, so a shared id would let one test's token satisfy
  // the next test's authenticate() and shift every stubbed answer by one. Each
  // case gets its own id.
  let n = 0;
  const secret = () => `snov-test-${n++}:secret`;

  it("polls the domain-search task and maps the company block", async () => {
    stub(
      TOKEN,
      [200, { data: { task_hash: "h" } }],
      [200, { status: "completed", data: { company_name: "Snov.io", city: "New York", founded: "2017", website: "snov.io", industry: "Computer Software", size: "51-200" } }],
    );
    const r = await SnovCompanyProvider.enrich("snov.io", secret());
    expect(r.data).toEqual({
      name: "Snov.io",
      industry: "Computer Software",
      city: "New York",
      foundedYear: 2017,
    });
    // `size` is a range, so it must not reach the INTEGER column.
    expect(r.data).not.toHaveProperty("employeeCount");
  });

  it("still charges a credit on a miss, because Snov bills per request", async () => {
    // The one vendor here that does. Recording it as free would understate
    // every run that reached it.
    stub(TOKEN, [200, { data: { task_hash: "h" } }], [200, { status: "completed", data: {} }]);
    const r = await SnovCompanyProvider.enrich("nowhere.example", secret());
    expect(r.outcome).toBe("miss");
    expect(r.creditsUsed).toBe(1);
  });

  it("refuses a secret that is not clientId:clientSecret without calling the vendor", async () => {
    stub([200, {}]);
    const r = await SnovCompanyProvider.enrich("snov.io", "just-a-key");
    expect(r.outcome).toBe("unconfigured");
    expect(calls).toHaveLength(0);
  });
});

// ── Registry-wide invariants ────────────────────────────────────────

describe("every company adapter", () => {
  it("maps a rejected key onto unconfigured, never a generic error", async () => {
    // To the user a rejected key and an absent key are the same problem, and
    // reporting one as a transient failure is how they never learn the key is
    // dead. Two vendors send it as a 400 rather than a 401, which is exactly
    // why this is asserted across the whole registry rather than per adapter.
    for (const p of COMPANY_REGISTRY) {
      const rejection =
        p.id === "tomba-company"
          ? [400, { errors: { type: "authentication_failed" } }]
          : p.id === "prospeo-company"
            ? [400, { error: true, error_code: "INVALID_API_KEY" }]
            : [401, { error: "Unauthenticated" }];
      // Snov authenticates first, so its rejection lands on the token call.
      stub(rejection as [number, unknown]);
      const r = await p.enrich("stripe.com", key(p));
      expect(r.outcome, `${p.id}: ${r.detail ?? "no detail"}`).toBe("unconfigured");
      expect(r.creditsUsed, `${p.id} spent credits on a rejected key`).toBe(0);
    }
  });

  it("never reports a hit when the vendor answers with nothing at all", async () => {
    // The failure this catches: an adapter that builds a record of undefineds
    // from an empty 200, calls it a hit, and bills a credit for it. The runner
    // would discard the empty record, so the only visible symptom is a ledger
    // that overstates every fruitless run.
    for (const p of COMPANY_REGISTRY) {
      // Snov authenticates before it looks anything up, so its token call has
      // to be answered or the empty body lands on the wrong request.
      const empty: [number, unknown] = [200, {}];
      if (p.id === "snov-company") stub([200, { access_token: "t", expires_in: 3600 }], empty, empty, empty);
      else stub(empty, empty, empty);
      const r = await p.enrich("nowhere.example", `${p.id}-empty:key`);
      expect(r.outcome, `${p.id} returned a hit for an empty body`).not.toBe("hit");
      expect(r.creditsUsed, `${p.id} billed for an empty body`).toBe(0);
    }
  });

  it("declares coverage that its own mapping can actually produce", async () => {
    // A vendor that overstates `covers` costs a credit for nothing; one that
    // understates it is never called. Neither is visible at a call site, so it
    // is asserted here: every declared field must be a real CompanyRecord key,
    // and the list must be non-empty and free of duplicates.
    const FIELDS = new Set([
      "name", "linkedinUrl", "industry", "city", "state", "country",
      "postalCode", "stockSymbol", "employeeCount", "foundedYear",
    ]);
    for (const p of COMPANY_REGISTRY) {
      expect(p.covers.length, `${p.id} declares no coverage`).toBeGreaterThan(0);
      expect(new Set(p.covers).size, `${p.id} lists a field twice`).toBe(p.covers.length);
      for (const f of p.covers) expect(FIELDS, `${p.id} declares unknown field ${f}`).toContain(f);
    }
  });

  it("gives every vendor a distinct id and reuses the person-side secret name", async () => {
    const ids = COMPANY_REGISTRY.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const { REGISTRY } = await import("./index");
    const personSecrets = new Set(REGISTRY.map((p) => p.secretName));
    for (const p of COMPANY_REGISTRY) {
      // One key per vendor, entered once — a separate secret name would make
      // the settings screen ask for the same key twice.
      expect(personSecrets, `${p.id} introduces a second secret for one vendor`).toContain(p.secretName);
    }
  });
});
