// Exporting a Sales Navigator search or lead list.
//
// The app never talks to LinkedIn. Sales Navigator is a signed-in product with
// no public API for this, so the list is read by the org's agent, in its own
// browser, under the user's own seat — the same arrangement as the LinkedIn
// signal monitors. What lives here is the part the app owns: deciding whether a
// pasted URL is something the agent can export at all, and the instruction that
// tells the agent how to do it and how to report back.

/**
 * Sales Navigator pages 25 results at a time and stops offering pages after the
 * 100th, so no single search yields more than this. A bigger search is not an
 * error — the first 2,500 are still worth having — but the user is told, so a
 * truncated export is never mistaken for a complete one.
 */
export const SALES_NAV_MAX_RESULTS = 2500;

/**
 * Longest URL accepted. Search URLs carry every filter in the query string and
 * run long; the brief that embeds one must still fit the platform's
 * 4000-character instruction cap.
 */
export const SALES_NAV_MAX_URL = 1500;

/** The platform refuses instructions longer than this. */
export const INSTRUCTION_CAP = 4000;

const PEOPLE_PATHS = ["/sales/search/people", "/sales/lists/people"];

/**
 * Accept a people search (including a saved one) or a people lead list, and
 * nothing else. Account searches and lists are refused rather than half-handled:
 * they list companies, and this export produces people.
 *
 * Returns the URL normalised to https with the fragment dropped, or an error a
 * person can act on.
 */
export function parseSalesNavigatorUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const text = raw.trim();
  if (text.length > SALES_NAV_MAX_URL) {
    return { ok: false, error: `That URL is over ${SALES_NAV_MAX_URL} characters. Save the search in Sales Navigator and paste the saved search's link instead.` };
  }
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: "That isn't a URL. Paste the link from your browser's address bar." };
  }
  const host = u.hostname.toLowerCase();
  if (host !== "linkedin.com" && host !== "www.linkedin.com") {
    return { ok: false, error: "That isn't a LinkedIn link. Paste a Sales Navigator search or lead list." };
  }
  if (u.pathname.startsWith("/sales/search/company") || u.pathname.startsWith("/sales/lists/company")) {
    return { ok: false, error: "That's an account search. Open a lead (people) search or lead list instead." };
  }
  if (!PEOPLE_PATHS.some((p) => u.pathname.startsWith(p))) {
    return { ok: false, error: "That isn't a Sales Navigator lead search or lead list." };
  }
  u.protocol = "https:";
  u.hash = "";
  return { ok: true, url: u.toString() };
}

/**
 * The export instruction. Like the sourcing brief, it is both what the agent
 * receives and what the user pastes into chat when dispatch is unavailable.
 */
export function salesNavigatorBrief(opts: {
  runId: string;
  url: string;
  appUrl: string;
  includeEmails: boolean;
}): string {
  const run = `/api/runs/${opts.runId}`;
  return [
    `Export this Sales Navigator list into OpenProspector (${opts.appUrl}):`,
    opts.url,
    ``,
    `1. PATCH ${run} {"status":"sourcing"}. Open the link in your browser, signed`,
    `   in to Sales Navigator. If you meet a sign-in page, CAPTCHA, restriction or`,
    `   rate limit, stop: PATCH ${run} {"status":"failed","error":"<what you saw>"}.`,
    `   Never work around it and never ask for a password.`,
    `2. Read the result count. Export at most the first ${SALES_NAV_MAX_RESULTS} (Sales Navigator`,
    `   shows no more). If there are more, remember the count for step 5.`,
    `3. For each results page, for each person: full_name, title, company,`,
    `   location, and source_url = their Sales Navigator lead link. Set`,
    `   linkedin_url only when a public linkedin.com/in/ link is shown; do not`,
    `   open each profile to find one.`,
    `   Open each company's Sales Navigator account page once (not once per`,
    `   person) and take: domain (bare website host), industry, employee_count`,
    `   (a number), company_city, company_country, company_linkedin_url`,
    `   (linkedin.com/company/…). Send them on every lead at that company.`,
    `4. After each page, POST /api/leads {"run_id":"${opts.runId}","leads":[…]} with`,
    `   source "sales_navigator". Move at a person's pace and open nothing else.`,
    `   Do not look up emails or phone numbers yourself.`,
    `5. If the search had more than ${SALES_NAV_MAX_RESULTS} results, PATCH ${run}`,
    `   {"error":"Exported ${SALES_NAV_MAX_RESULTS} of <count>. Narrow the search to export the rest."}.`,
    opts.includeEmails
      ? `6. Then POST ${run}/enrich. The app finds and verifies work emails.`
      : `6. Then PATCH ${run} {"status":"done"}. No emails were requested.`,
  ].join("\n");
}
