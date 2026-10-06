// Companies a signal found, and the search opened for each: who to contact
// there. One search per company domain, whichever signals find it, so a
// company is never researched twice. The people it finds join the lists of
// every signal that found the company (lists.ts, joinFromRun).

import { get, query, run } from "./db.js";
import { joinCompany } from "./lists.js";
import { dispatchCompanySearches } from "./runs.js";
import type { AgentEnv } from "./agent.js";

export interface Company {
  name: string;
  domain: string;
  reason: string;
  source_url: string;
}

/** The signal a company search is opened for: its name and who to look for. */
export interface SearchingSignal {
  id: string;
  name: string;
  who_to_contact: string;
}

/** The company a finding names, or null for a person. */
export function companyOf(details: string): Company | null {
  const d = JSON.parse(details) as {
    kind?: string;
    subject?: { type?: string; name?: string; domain?: string };
    reason?: string;
    source_url?: string;
  };
  if (d.kind !== "custom" || d.subject?.type !== "company" || !d.subject.domain) return null;
  return { name: d.subject.name || d.subject.domain, domain: d.subject.domain, reason: d.reason ?? "", source_url: d.source_url ?? "" };
}

/** Who to look for when the signal names nobody. Owner first: a small business rarely has anyone else. */
const DEFAULT_WHO = "the owner or managing director; at a larger company, up to 3 people who would decide, best first";

/** The prompt a company search carries: who to look for there, and why the company. */
export function companyPrompt(signal: SearchingSignal, company: Company): string {
  return [
    `Who to contact at ${company.name} (${company.domain}): ${signal.who_to_contact || DEFAULT_WHO}.`,
    `Why this company: ${company.reason}`,
    `Found by the signal "${signal.name}": ${company.source_url}`,
  ]
    .join("\n")
    .slice(0, 2000);
}

/** Opens the search for a company, unless one exists (idx_runs_company decides, atomically). */
export async function openSearch(signal: SearchingSignal, company: Company): Promise<{ id: string; created: boolean }> {
  const id = crypto.randomUUID();
  const res = await run(
    "INSERT INTO runs (id, icp_prompt, status, company_domain) VALUES (?, ?, 'pending', ?) ON CONFLICT DO NOTHING",
    [id, companyPrompt(signal, company), company.domain],
  );
  if (res.changes > 0) return { id, created: true };
  const existing = await get<{ id: string }>("SELECT id FROM runs WHERE company_domain = ?", [company.domain]);
  return { id: existing!.id, created: false };
}

/**
 * Companies a signal found get their people. Those already found at a company
 * join the signal's lists at once; companies nobody searched yet get a search,
 * handed to the agent together. Returns the lists that grew.
 */
export async function searchCompanies(
  env: AgentEnv,
  appUrl: string,
  signal: SearchingSignal,
  companies: Company[],
): Promise<string[]> {
  const grew = new Set<string>();
  const opened: string[] = [];
  const seen = new Set<string>();
  for (const company of companies) {
    if (seen.has(company.domain)) continue;
    seen.add(company.domain);
    const search = await openSearch(signal, company);
    if (search.created) opened.push(search.id);
    else for (const listId of await joinCompany(signal.id, company.domain)) grew.add(listId);
  }
  if (opened.length) await dispatchCompanySearches(env, appUrl, opened);
  return [...grew];
}

/** A signal's visible companies nobody searched yet, newest first, at most `limit`. */
export async function unsearchedCompanies(monitorId: string, limit: number): Promise<Company[]> {
  const rows = await query<{ details: string }>(
    `SELECT o.details FROM signal_observations o
      WHERE o.rowid IN (
        SELECT MAX(rowid) FROM signal_observations
         WHERE monitor_id = ? AND visible = 1 AND json_extract(details, '$.subject.type') = 'company'
         GROUP BY json_extract(details, '$.subject.domain'))
        AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.company_domain = json_extract(o.details, '$.subject.domain'))
      ORDER BY o.observed_at DESC, o.rowid DESC LIMIT ?`,
    [monitorId, limit],
  );
  return rows.map((r) => companyOf(r.details)).filter((c): c is Company => c !== null);
}
