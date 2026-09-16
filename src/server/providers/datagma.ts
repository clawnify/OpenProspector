// Datagma adapter — email and mobile, both synchronous.
//
// Contract verified against https://datagmaapi.readme.io/reference/ :
//   GET /api/ingress/v8/findEmail?apiId=&fullName=&firstName=&lastName=
//                                &company=&linkedInSlug=
//       -> { email, emailDomain, status, patterns[], mxfound, smtpCheck, cachAll }
//   GET /api/ingress/v2/full?apiId=&fullName=&data=&phoneFull=true
//       -> { phone: { mobiles: [{ value }], workPhones: [{ value }] }, creditBurn }
//   GET /api/ingress/v1/mine?apiId= -> { currentCredit }
//   Auth: apiId query parameter (Datagma has no header form)
//
// **Three traps, each of which produces a plausible-looking wrong adapter:**
//
//  1. **The finder is v8.** Datagma's own guide pages still show `v6/findEmail`,
//     and its API reference lists `findEmailV8`. The guides are stale; the
//     reference is the contract. Pinning v6 from a guide is the likely default
//     mistake here, so it is called out rather than left to a future reader.
//  2. **`linkedInSlug` is the *company* LinkedIn slug, not the person's.**
//     Their reference is explicit: "Linkedin Company Slug URL. If you do not
//     have the domain, we will extract it for you." Every other vendor in this
//     registry takes the person's profile URL, so passing `input.linkedinUrl`
//     here is the natural reflex — and it silently degrades the match, because
//     Datagma resolves it as the employer.
//  3. **`cachAll` is spelled that way in their schema.** It is their typo for
//     catch-all, not ours; correcting it reads the wrong (absent) field, which
//     makes every catch-all guess look like a verified mailbox.
//
// Pricing: Datagma documents that only verified emails are billed — a
// "most probable" catch-all guess is returned free. The enrichment endpoint
// reports its own cost as `creditBurn`, so phone spend is recorded as charged
// rather than assumed.

import type {
  CompanyProvider,
  CompanyResult,
  CreditBalance,
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
  LeadInput,
} from "./types";
import { absoluteLinkedIn, ineligible, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://gateway.datagma.net";

interface FindEmailBody {
  email?: string | null;
  smtpCheck?: boolean;
  mxfound?: boolean;
  /** Datagma's own spelling of "catch-all". See trap 3 above. */
  cachAll?: boolean;
  status?: string | null;
}

interface FullApiBody {
  phone?: {
    mobiles?: { value?: string | null }[] | null;
    workPhones?: { value?: string | null }[] | null;
  } | null;
  creditBurn?: number;
}

export const DatagmaProvider: EnrichProvider = {
  id: "datagma",
  label: "Datagma",
  fields: ["email", "phone"],
  secretName: "DATAGMA_API_KEY",
  signupUrl: "https://app.datagma.com/user-api",

  requirements(field: EnrichField): InputRequirement {
    if (field === "email") return ["fullName", ["domain", "company"]];
    // The enrichment endpoint's `data` accepts an email, a LinkedIn URL, a
    // company name or a website, so a phone lookup has more ways in than the
    // finder does.
    return [
      ["linkedinUrl", "email", "fullName"],
      ["linkedinUrl", "email", "domain", "company"],
    ];
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    return field === "email" ? findEmail(input, apiKey) : findPhone(input, apiKey);
  },

  async credits(apiKey): Promise<CreditBalance> {
    const { status, body } = await vendorFetch(`${BASE}/api/ingress/v1/mine?apiId=${encodeURIComponent(apiKey)}`, {});
    if (status < 200 || status >= 300) return { remaining: null };
    // Documented as an int64, which their gateway serialises as a string.
    const raw = (body as { currentCredit?: unknown } | null)?.currentCredit;
    const n = typeof raw === "string" ? Number(raw) : raw;
    return { remaining: typeof n === "number" && Number.isFinite(n) ? n : null };
  },
};

async function findEmail(input: LeadInput, apiKey: string): Promise<EnrichResult> {
  if (!input.fullName || !(input.domain || input.company)) {
    return ineligible("Needs a full name and a domain or company");
  }

  const q = new URLSearchParams({ apiId: apiKey, fullName: input.fullName });
  // `company` takes a domain *or* a company name; the domain is the stronger
  // signal, so it wins when we have both.
  q.set("company", input.domain || input.company || "");

  const { status, body } = await vendorFetch(`${BASE}/api/ingress/v8/findEmail?${q}`, {});
  if (status < 200 || status >= 300) {
    const { outcome, detail } = statusOutcome(status, "Datagma");
    return { outcome, value: null, verified: false, creditsUsed: 0, detail };
  }

  const b = body as FindEmailBody | null;
  if (!b?.email) return miss();

  // An SMTP-confirmed mailbox on a non-catch-all domain is the only result
  // Datagma asserts, and the only one it bills for. Everything else is their
  // "most probable email" — a pattern guess, kept as an unverified fallback.
  const verified = b.smtpCheck === true && b.cachAll !== true;
  return {
    outcome: "hit",
    value: b.email,
    verified,
    creditsUsed: verified ? 1 : 0,
    detail: verified ? undefined : "Most probable address (catch-all domain, not SMTP-verified)",
  };
}

async function findPhone(input: LeadInput, apiKey: string): Promise<EnrichResult> {
  // Strongest identifier first: a profile URL or an email resolves one person,
  // where a name and a company name can resolve several.
  const identifier = input.linkedinUrl || input.email || input.domain || input.company;
  if (!identifier) return ineligible("Needs a profile URL, an email, or a company");
  if (!input.linkedinUrl && !input.email && !input.fullName) {
    return ineligible("Needs a full name when matching on a company");
  }

  const q = new URLSearchParams({ apiId: apiKey, data: identifier, phoneFull: "true" });
  if (input.fullName) q.set("fullName", input.fullName);

  const { status, body } = await vendorFetch(`${BASE}/api/ingress/v2/full?${q}`, {});
  if (status < 200 || status >= 300) {
    const { outcome, detail } = statusOutcome(status, "Datagma");
    return { outcome, value: null, verified: false, creditsUsed: 0, detail };
  }

  const b = body as FullApiBody | null;
  const charged = typeof b?.creditBurn === "number" ? b.creditBurn : 0;
  // Mobiles before switchboard numbers: this waterfall exists to produce a
  // number you can actually reach a person on, and a company landline resolves
  // the field while being useless for that.
  const mobile = b?.phone?.mobiles?.find((p) => p?.value)?.value;
  const work = b?.phone?.workPhones?.find((p) => p?.value)?.value;
  const value = mobile || work;
  if (!value) return miss("No number found", charged);

  return {
    outcome: "hit",
    value,
    // Datagma returns numbers it holds as current; it publishes no per-number
    // confidence flag, so a work landline is not asserted as a direct line.
    verified: Boolean(mobile),
    creditsUsed: charged,
    detail: mobile ? undefined : "Company switchboard number, not a direct mobile",
  };
}

// ── Company enrichment ──────────────────────────────────────────────
//
// Contract verified against Datagma's API reference on 2026-09-03
// (https://datagmaapi.readme.io/reference/ingressservice_fullapiv2), and the
// endpoint probed live (`{"code":16,"message":"apiId is not valid"}` on a bad
// key):
//   GET /api/ingress/v2/full?apiId=&data=<domain>&companyPremium=true
//        -> { company: {
//               basic:   { name, website, yearFounded, industry, size,
//                          locality, region, country, linkedUrl },
//               premium: { name, url, founded, industries, companySize,
//                          headquaterAddrLocality, headquaterAddrRegion,
//                          headquaterAddrCountry, headquaterAddrPostalCode } },
//             creditBurn }
//   Auth: apiId query parameter (Datagma has no header form)
//
// **This is the same endpoint as the phone lookup, with a different flag set.**
// `data` accepts a domain as readily as a person, and the person adapter above
// already calls `/v2/full` — the difference is only that this one asks for the
// company blocks and none of the person ones.
//
// `companyPremium` is on and `companyFull` is off, deliberately: premium is
// what carries the HQ postal code, while full is documented as *financial*
// data (funding, traffic, IPO) that fills no CompanyRecord field and is priced
// accordingly. Turning on a paid block that maps to nothing is pure waste.
//
// `headquaterAddr*` is Datagma's own spelling, not a typo here — the same class
// of trap as `cachAll` in the finder above.
//
// The two blocks are merged basic-first because basic carries `linkedUrl`,
// which premium's `url` does not promise to be a LinkedIn page. No ticker in
// either block. `size` / `companySize` are bucketed ranges, so employeeCount is
// left unset rather than parsed out of one.

interface CompanyBlocks {
  basic?: {
    name?: string | null;
    yearFounded?: number | null;
    industry?: string | null;
    locality?: string | null;
    region?: string | null;
    country?: string | null;
    linkedUrl?: string | null;
  } | null;
  premium?: {
    name?: string | null;
    founded?: number | null;
    industries?: string | string[] | null;
    headquaterAddrLocality?: string | null;
    headquaterAddrRegion?: string | null;
    headquaterAddrCountry?: string | null;
    headquaterAddrPostalCode?: string | null;
  } | null;
}

export const DatagmaCompanyProvider: CompanyProvider = {
  id: "datagma-company",
  label: "Datagma",
  secretName: "DATAGMA_API_KEY",
  signupUrl: "https://app.datagma.com/user-api",
  covers: ["name", "linkedinUrl", "industry", "city", "state", "country", "postalCode", "foundedYear"],

  async enrich(domain, apiKey): Promise<CompanyResult> {
    const q = new URLSearchParams({ apiId: apiKey, data: domain, companyPremium: "true" });
    const { status, body } = await vendorFetch(`${BASE}/api/ingress/v2/full?${q}`, {});

    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "Datagma");
      return { outcome, data: null, creditsUsed: 0, detail };
    }

    const b = body as { company?: CompanyBlocks | null; creditBurn?: number } | null;
    const basic = b?.company?.basic ?? {};
    const premium = b?.company?.premium ?? {};
    const name = basic.name || premium.name || undefined;
    // What the vendor says it charged, as on the phone lookup.
    const creditsUsed = typeof b?.creditBurn === "number" ? b.creditBurn : 0;

    if (!name) return { outcome: "miss", data: null, creditsUsed, detail: "No company matched this domain" };

    const industries = premium.industries;
    return {
      outcome: "hit",
      creditsUsed,
      data: {
        name,
        industry: basic.industry || (Array.isArray(industries) ? industries[0] : industries) || undefined,
        linkedinUrl: absoluteLinkedIn(basic.linkedUrl),
        foundedYear: basic.yearFounded ?? premium.founded ?? undefined,
        city: basic.locality || premium.headquaterAddrLocality || undefined,
        state: basic.region || premium.headquaterAddrRegion || undefined,
        country: basic.country || premium.headquaterAddrCountry || undefined,
        postalCode: premium.headquaterAddrPostalCode || undefined,
      },
    };
  },
};
