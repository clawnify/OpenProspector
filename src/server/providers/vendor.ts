// Shared vendor plumbing. Every adapter needs the same three things, so they
// live here once rather than eight times over: a fetch that cannot throw on a
// non-JSON error body, the HTTP-status → outcome mapping almost every vendor
// follows, and the input requirement four of them share.

import type { AttemptOutcome, EnrichResult, InputRequirement } from "./types";

export interface VendorResponse {
  status: number;
  body: unknown;
}

/**
 * One vendor call. Adapters are contracted never to throw, and the single most
 * common way they would is a vendor answering an error with HTML: `res.json()`
 * rejects, and a 502 becomes an unhandled exception mid-batch. So the parse is
 * swallowed and the caller decides based on `status`.
 */
export async function vendorFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<VendorResponse> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/**
 * The status mapping nearly every vendor in this registry shares. Adapters
 * override the cases where their vendor genuinely differs rather than each
 * restating the common ones.
 *
 * `401/403 → unconfigured` is deliberate: to the user, a rejected key and an
 * absent key are the same problem — this vendor is not usable until they fix
 * the key — and both must skip rather than fail the run.
 */
export function statusOutcome(
  status: number,
  vendor: string,
): { outcome: Exclude<AttemptOutcome, "pending">; detail: string } {
  if (status === 401 || status === 403) return { outcome: "unconfigured", detail: `${vendor} rejected the API key` };
  if (status === 402) return { outcome: "no_credits", detail: `Out of ${vendor} credits` };
  if (status === 404) return { outcome: "miss", detail: "No record found" };
  if (status === 429) return { outcome: "error", detail: `Rate limited by ${vendor}` };
  return { outcome: "error", detail: `${vendor} returned HTTP ${status}` };
}

/** A skip that spent nothing, in the shape `find()` must return. */
export function ineligible(detail: string): EnrichResult {
  return { outcome: "ineligible", value: null, verified: false, creditsUsed: 0, detail };
}

/** A vendor-searched-and-found-nothing answer. */
export function miss(detail = "No record found", creditsUsed = 0): EnrichResult {
  return { outcome: "miss", value: null, verified: false, creditsUsed, detail };
}

/**
 * "A strong identifier, or a name plus something that identifies the company."
 *
 * Reads as two alternative groups, both of which must be satisfied:
 *   1. profile URL, or email, or a name
 *   2. profile URL, or email, or a domain, or a company name
 *
 * So a profile URL alone passes, an email alone passes, and name + domain
 * passes — but a bare name does not, because no vendor can resolve "John Smith"
 * without knowing where he works, and calling one anyway spends a credit to
 * learn that. Shared by the four vendors that accept alternative identifiers.
 */
export const IDENTIFIED_PERSON: InputRequirement = [
  ["linkedinUrl", "email", "fullName"],
  ["linkedinUrl", "email", "domain", "company"],
];

/**
 * The `linkedin.com/in/<slug>` public identifier. Some vendors key on the slug
 * rather than the URL, and our leads carry whatever the agent sourced — with or
 * without a trailing slash, query string, or locale subdomain.
 */
export function linkedinSlug(url: string | undefined): string | null {
  if (!url) return null;
  const m = /\/in\/([^/?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

/** First and last name, from parts when we have them and from `fullName` otherwise. */
export function nameParts(input: { firstName?: string; lastName?: string; fullName?: string }): { first: string; last: string } | null {
  if (input.firstName && input.lastName) return { first: input.firstName, last: input.lastName };
  const parts = (input.fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/**
 * Polling schedule for vendors that accept a lookup and finish it a few
 * seconds later. Shared by the adapters that poll in-band, and mutable so the
 * tests can run the real loop without sleeping through it.
 *
 * shortcut: a hard wall-clock cap, same trade as Wiza's — the alternative is
 * the deferred path, which only helps vendors that deliver by callback. A
 * timeout here is a paid-for result we drop, so the vendor's own id goes into
 * the attempt detail for retrieval by hand.
 */
export const POLL = {
  maxWaitMs: 25_000,
  firstPollMs: 1_000,
  intervalMs: 1_500,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Call `check` on the schedule until it settles or the cap is reached.
 * `check` returns `{ done: true, value }` when the vendor has finished, or
 * `{ done: false }` to keep waiting; `null` on timeout.
 */
export async function pollUntil<T>(check: () => Promise<{ done: true; value: T } | { done: false }>): Promise<T | null> {
  const deadline = Date.now() + POLL.maxWaitMs;
  await sleep(POLL.firstPollMs);
  for (;;) {
    const r = await check();
    if (r.done) return r.value;
    if (Date.now() + POLL.intervalMs > deadline) return null;
    await sleep(POLL.intervalMs);
  }
}

/**
 * A LinkedIn *company page* URL, from the three shapes vendors hand back.
 *
 * Shared because each vendor stops at a different point along the same string:
 *   full URL       "https://www.linkedin.com/company/stripe"  (Apollo)
 *   no scheme      "linkedin.com/company/stripe"              (People Data Labs)
 *   bare handle    "company/stripe"                           (Hunter)
 *
 * This matters more than it looks: the value goes into the
 * `linkedincompanypageurl` column of a LinkedIn Matched Audiences upload, and
 * the two shorter shapes are not URLs at all. Returns undefined for anything
 * that is not a company page — a *personal* profile (`/in/…`) in that column
 * would either be rejected or matched to the wrong entity.
 */
export function absoluteLinkedIn(raw: string | null | undefined): string | undefined {
  const v = String(raw ?? "").trim();
  if (!v) return undefined;
  const path = v
    .replace(/^https?:\/\//i, "")
    .replace(/^[a-z]{2,3}\.linkedin\.com\//i, "")
    .replace(/^www\.linkedin\.com\//i, "")
    .replace(/^linkedin\.com\//i, "")
    .replace(/^\/+/, "");
  const m = /^(company|showcase|school)\/([^/?#]+)/i.exec(path);
  return m ? `https://www.linkedin.com/${m[1].toLowerCase()}/${m[2]}` : undefined;
}
