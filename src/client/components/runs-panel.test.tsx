import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunFilter, runFilterLabel } from "./runs-panel";
import type { Run } from "../api";

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1", icp_prompt: "Dutch building firms", status: "done", lead_count: 2, credits_spent: 0, error: "",
  created_at: "2026-10-10 12:00:00", updated_at: "2026-10-10 12:05:00", stale: 0, source: "icp",
  enrich_fields: "email,phone", auto_enrich: 0, ...over,
});

it("names what the table is filtered to: a company search by its company, not its long prompt", () => {
  expect(runFilterLabel(run({ company_domain: "nieuwevoorruit.nl", icp_prompt: "Who to contact at NieuweVoorruit (nieuwevoorruit.nl): the owner." })))
    .toBe("People found at nieuwevoorruit.nl");
  expect(runFilterLabel(run({ source: "sales_navigator", icp_prompt: "https://www.linkedin.com/sales/search/people?savedSearchId=1" })))
    .toBe("Leads from a Sales Navigator export");
  expect(runFilterLabel(run())).toBe("Leads from “Dutch building firms”");
  expect(runFilterLabel(null)).toBe("Leads from one search");
});

it("shows the filter as a pill whose button goes back to every lead", () => {
  const html = renderToStaticMarkup(<RunFilter run={run({ company_domain: "greeuw.nl" })} onClear={() => {}} />);
  expect(html).toContain("People found at greeuw.nl");
  expect(html).toContain('aria-label="Show all leads"');
});
