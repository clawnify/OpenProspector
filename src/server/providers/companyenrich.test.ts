import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyEnrichCompanyProvider as provider } from "./companyenrich";
import { COMPANY_REGISTRY, companyDefaultOrder, runCompanyWaterfall } from "./company";
import { REGISTRY } from "./index";

// Fictional fixture shaped from CompanyInfo in the public OpenAPI schema.
const COMPANY = {
  id: "00000000-0000-4000-8000-000000000001",
  name: " Example Research ",
  domain: "example.com",
  industry: "Software",
  founded_year: 2012,
  employees: "51-200",
  reported_employees: "51-200",
  location: {
    city: { id: 1, name: "Austin" },
    state: { id: 2, name: "Texas", code: "TX" },
    country: { name: "United States", code: "US" },
    postal_code: "78701",
  },
  socials: { linkedin_url: "https://www.linkedin.com/company/example-research/" },
  financial: { stock_symbol: "EXMP" },
};

function stub(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("CompanyEnrich company provider", () => {
  it("maps every declared company field from its real nesting without inventing a headcount", async () => {
    const fetch = stub(200, COMPANY, { "x-credit-cost": "1" });
    const result = await provider.enrich("example.com", "fixture-key");
    expect(result).toEqual({
      outcome: "hit",
      creditsUsed: 1,
      data: {
        name: "Example Research",
        industry: "Software",
        linkedinUrl: "https://www.linkedin.com/company/example-research",
        city: "Austin",
        state: "Texas",
        country: "United States",
        postalCode: "78701",
        stockSymbol: "EXMP",
        foundedYear: 2012,
      },
    });
    expect(Object.keys(result.data!).sort()).toEqual([...provider.covers].sort());
    expect(result.data).not.toHaveProperty("employeeCount");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.companyenrich.com/companies/enrich?domain=example.com&waitForEnrichment=false");
    expect(init.headers).toEqual({ Accept: "application/json", Authorization: "Bearer fixture-key" });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new URL(url).searchParams.has("expand")).toBe(false);
  });

  it.each(["0", "3"])("records the actual %s credit charge", async (cost) => {
    stub(200, COMPANY, { "x-credit-cost": cost });
    expect((await provider.enrich("example.com", "fixture-key")).creditsUsed).toBe(Number(cost));
  });

  it.each(["", "-1", "NaN", "1.2", "9007199254740992"])("ignores an invalid cost header %j", async (cost) => {
    stub(200, COMPANY, { "x-credit-cost": cost });
    expect((await provider.enrich("example.com", "fixture-key")).creditsUsed).toBe(1);
  });

  it("keeps partial records without turning nullable fields into made-up values", async () => {
    stub(200, { id: COMPANY.id, name: null, location: { country: { code: "NL" } }, socials: null, financial: null });
    const result = await provider.enrich("example.com", "fixture-key");
    expect(result.outcome).toBe("hit");
    expect(result.data?.country).toBe("NL");
    expect(result.data?.foundedYear).toBeUndefined();
    expect(result.data?.stockSymbol).toBeUndefined();
  });

  it("does not turn a person's LinkedIn profile into a company page", async () => {
    stub(200, { ...COMPANY, socials: { linkedin_url: "https://www.linkedin.com/in/example-person" } });
    expect((await provider.enrich("example.com", "fixture-key")).data?.linkedinUrl).toBeUndefined();
  });

  it("records a free miss when the domain has no stored record", async () => {
    stub(404, { detail: "No company" });
    expect(await provider.enrich("example.com", "fixture-key")).toMatchObject({ outcome: "miss", data: null, creditsUsed: 0 });
  });

  it.each([[401, "unconfigured"], [402, "no_credits"], [429, "error"], [500, "error"]])("maps HTTP %s without exposing upstream text", async (status, outcome) => {
    stub(Number(status), { detail: "private fixture-key account information" });
    const result = await provider.enrich("example.com", "fixture-key");
    expect(result).toMatchObject({ outcome, data: null, creditsUsed: 0 });
    expect(JSON.stringify(result)).not.toContain("fixture-key");
  });

  it.each([{}, null, [], { id: COMPANY.id }, { ...COMPANY, location: "wrong-shape" }])("reports malformed or unsupported paid data as unmapped", async (body) => {
    stub(200, body, { "x-credit-cost": "2" });
    expect(await provider.enrich("example.com", "fixture-key")).toMatchObject({ outcome: "unmapped", data: null, creditsUsed: 2 });
  });

  it("retains the charged cost if JSON parsing fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON", { status: 200, headers: { "x-credit-cost": "1" } })));
    expect(await provider.enrich("example.com", "fixture-key")).toMatchObject({ outcome: "unmapped", creditsUsed: 1 });
  });

  it("never retries a failed request or leaks its exception", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("private fixture-key transport detail"));
    vi.stubGlobal("fetch", fetch);
    const result = await provider.enrich("example.com", "fixture-key");
    expect(result.outcome).toBe("error");
    expect(result.detail).toContain("credit usage is unknown");
    expect(result.detail).not.toContain("fixture-key");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects missing keys and invalid direct-call domains without a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await provider.enrich("example.com", "")).outcome).toBe("unconfigured");
    expect((await provider.enrich("https://example.com", "key")).outcome).toBe("ineligible");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is available only in the company waterfall and logs its actual cost", async () => {
    expect(COMPANY_REGISTRY).toContain(provider);
    expect(companyDefaultOrder()).toContain(provider.id);
    expect(REGISTRY.some((p) => p.secretName === provider.secretName)).toBe(false);
    const fetch = stub(200, COMPANY, { "x-credit-cost": "3" });
    const result = await runCompanyWaterfall("https://www.example.com/path", { COMPANYENRICH_API_KEY: "fixture-key" }, { order: [provider.id] });
    expect(result).toMatchObject({ providerId: provider.id, totalCredits: 3, data: { name: "Example Research" } });
    expect(result.attempts).toEqual([expect.objectContaining({ providerId: provider.id, field: "company", outcome: "hit", creditsUsed: 3 })]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not spend when its key is absent", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await runCompanyWaterfall("example.com", {}, { order: [provider.id] });
    expect(result.attempts).toEqual([expect.objectContaining({ outcome: "unconfigured", creditsUsed: 0 })]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("CompanyEnrich free account balance", () => {
  it("returns only the remaining credits through the free /me endpoint", async () => {
    const fetch = stub(200, { userId: "private-user", credits: { total: 100, used: 35 }, apiKey: "private-key" });
    expect(await provider.credits!("fixture-key")).toEqual({ remaining: 65 });
    expect(fetch.mock.calls[0][0]).toBe("https://api.companyenrich.com/me");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("keeps an exhausted balance at zero", async () => {
    stub(200, { credits: { total: 100, used: 100 } });
    expect(await provider.credits!("key")).toEqual({ remaining: 0 });
  });
  it.each([[401, {}], [200, { credits: { total: "100", used: 1 } }], [200, {}]])("reports unavailable balances as unknown", async (status, body) => {
    stub(Number(status), body);
    expect(await provider.credits!("key")).toEqual({ remaining: null });
  });
});
