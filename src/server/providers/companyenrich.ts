// CompanyEnrich's domain lookup returns CompanyInfo directly, not a data envelope.
// Contract: https://docs.companyenrich.com/reference/get_companies-enrich
// The base response's employees/reported_employees are ranges, not exact counts.
import { z } from "zod";
import type { CompanyProvider, CompanyRecord, CompanyResult } from "./types";
import { absoluteLinkedIn, statusOutcome } from "./vendor";

const BASE = "https://api.companyenrich.com";
const namedPlace = z.object({ name: z.string().nullish() }).nullish();
const companySchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullish(),
  industry: z.string().nullish(),
  founded_year: z.number().int().nullish(),
  location: z.object({
    city: namedPlace,
    state: namedPlace,
    country: z.object({ name: z.string().nullish(), code: z.string().nullish() }).nullish(),
    postal_code: z.string().nullish(),
  }).nullish(),
  socials: z.object({ linkedin_url: z.string().nullish() }).nullish(),
  financial: z.object({ stock_symbol: z.string().nullish() }).nullish(),
});

function text(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** Never repeat a paid request; a lost response may already have spent credits. */
async function request(path: string, apiKey: string) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const header = response.headers?.get("x-credit-cost");
  const amount = header && /^\d+$/.test(header.trim()) ? Number(header) : NaN;
  const credits = Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Retain the HTTP status and charged credits when a response is malformed.
  }
  return { status: response.status, body, credits };
}

export const CompanyEnrichCompanyProvider: CompanyProvider = {
  id: "companyenrich-company",
  label: "CompanyEnrich",
  secretName: "COMPANYENRICH_API_KEY",
  signupUrl: "https://companyenrich.com/pricing",
  covers: ["name", "linkedinUrl", "industry", "city", "state", "country", "postalCode", "stockSymbol", "foundedYear"],

  async enrich(domain, apiKey): Promise<CompanyResult> {
    if (!apiKey.trim()) return { outcome: "unconfigured", data: null, creditsUsed: 0, detail: "No CompanyEnrich API key configured" };
    // The runner normalizes domains. Also reject invalid direct calls before spending.
    if (domain.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) {
      return { outcome: "ineligible", data: null, creditsUsed: 0, detail: "CompanyEnrich needs a bare company domain" };
    }
    try {
      // Cached data keeps this waterfall bounded. An unstored domain returns a
      // free 404 and schedules enrichment; a later user-requested run can find it.
      const params = new URLSearchParams({ domain, waitForEnrichment: "false" });
      const { status, body, credits } = await request(`/companies/enrich?${params}`, apiKey);
      if (status === 404) {
        return { outcome: "miss", data: null, creditsUsed: credits ?? 0, detail: "No stored company found; background enrichment may make a later lookup available" };
      }
      if (status < 200 || status >= 300) {
        return { ...statusOutcome(status, "CompanyEnrich"), data: null, creditsUsed: credits ?? 0 };
      }

      // A successful base lookup costs one credit if the cost header is absent.
      // A malformed paid answer is not a free miss, and never a usable hit.
      const creditsUsed = credits ?? 1;
      const parsed = companySchema.safeParse(body);
      if (!parsed.success) {
        return { outcome: "unmapped", data: null, creditsUsed, detail: "CompanyEnrich returned an unexpected company response" };
      }
      const c = parsed.data;
      const data: CompanyRecord = {
        name: text(c.name),
        linkedinUrl: absoluteLinkedIn(text(c.socials?.linkedin_url)),
        industry: text(c.industry),
        city: text(c.location?.city?.name),
        state: text(c.location?.state?.name),
        country: text(c.location?.country?.name) ?? text(c.location?.country?.code),
        postalCode: text(c.location?.postal_code),
        stockSymbol: text(c.financial?.stock_symbol),
        foundedYear: c.founded_year ?? undefined,
      };
      if (!Object.values(data).some((value) => value !== undefined)) {
        return { outcome: "unmapped", data: null, creditsUsed, detail: "CompanyEnrich matched a company but returned no supported firmographic fields" };
      }
      return { outcome: "hit", data, creditsUsed };
    } catch {
      return { outcome: "error", data: null, creditsUsed: 0, detail: "CompanyEnrich request failed; credit usage is unknown and the request was not retried" };
    }
  },

  async credits(apiKey) {
    if (!apiKey.trim()) return { remaining: null };
    try {
      // /me is free. Only the balance leaves this function, never account data.
      const { status, body } = await request("/me", apiKey);
      if (status !== 200) return { remaining: null };
      const parsed = z.object({ credits: z.object({
        total: z.number().int().nonnegative(),
        used: z.number().int().nonnegative(),
      }) }).safeParse(body);
      return { remaining: parsed.success ? Math.max(0, parsed.data.credits.total - parsed.data.credits.used) : null };
    } catch {
      return { remaining: null };
    }
  },
};
