import { afterEach, describe, expect, it, vi } from "vitest";

// No saved preference means the catalog returns the registered default order.
vi.mock("./db.js", () => ({
  get: async () => null,
  query: async () => [],
  run: async () => undefined,
}));
import app from "./index";

const env = {
  CLAWNIFY_TOKEN: "test-only-token",
  COMPANYENRICH_API_KEY: "test-company-key",
  DB: { prepare: () => { throw new Error("use the mocked preference store"); } },
};

afterEach(() => vi.unstubAllGlobals());

describe("company-only provider catalog", () => {
  it("lists CompanyEnrich without making a billable request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await app.request("https://prospector.example/api/providers", {}, env);
    expect(response.status).toBe(200);
    const body = await response.json() as { providers: { id: string; fields: string[]; configured: boolean }[] };
    expect(body.providers.find((p) => p.id === "companyenrich-company")).toMatchObject({ fields: ["company"], configured: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads a company-only balance on explicit request without exposing account data", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ userId: "private-user", credits: { total: 100, used: 10 } })));
    vi.stubGlobal("fetch", fetch);
    const response = await app.request("https://prospector.example/api/providers?credits=true", {}, env);
    expect(response.status).toBe(200);
    const body = await response.json() as { providers: { id: string; credits_remaining: number }[] };
    expect(body.providers.find((p) => p.id === "companyenrich-company")?.credits_remaining).toBe(90);
    expect(JSON.stringify(body)).not.toContain("private-user");
    expect(JSON.stringify(body)).not.toContain("test-company-key");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("https://api.companyenrich.com/me");
  });
});
