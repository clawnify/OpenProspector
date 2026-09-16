// A signal is a dated, public reason to talk to a company *now*. It is not a
// lead: it has no person attached, and it is about the account.
//
// The whole value of storing them is that two useful things are invisible to a
// stateless sweep: whether we have seen this exact item before (so a re-sweep
// does not open a second run and spend enrichment credits twice), and whether
// a job post keeps coming back (a role reposted four times is a role nobody
// can fill, which is a stronger signal than the first posting was).
//
// Everything here is pure so it can be tested without a database.

/** Signal types we know a freshness window for. Anything else falls back to OTHER_WINDOW_DAYS. */
export const SIGNAL_WINDOWS: Record<string, number> = {
  // Past three weeks a role is usually filled or the budget moved. Operators
  // who scrape boards put the practical ceiling lower than this; 21 is the
  // point past which it is not worth a human's attention at all.
  hiring: 21,
  // Funding, a new office, a new market. Past two months every competitor has
  // already worked the list.
  funding: 56,
  // A new page about the problem we solve, or a tool appearing in their stack.
  // Slow-moving, and the evidence stays up.
  site_change: 30,
  stack: 30,
  // Somebody describing the pain in their own words.
  review: 30,
};

/** Used for a type we have no specific window for. Deliberately short. */
export const OTHER_WINDOW_DAYS = 14;

export function windowDaysFor(type: string): number {
  return SIGNAL_WINDOWS[type] ?? OTHER_WINDOW_DAYS;
}

/**
 * Bare registrable host: no scheme, no `www.`, no path, no port, lowercased.
 * This is the join key across signals, leads, and whatever CRM the org uses,
 * so it has to be derived the same way every time.
 */
export function normalizeDomain(input: string): string {
  let s = (input || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  s = s.split("@").pop() ?? s;
  s = s.split(":")[0];
  if (s.startsWith("www.")) s = s.slice(4);
  return s;
}

/**
 * Same item, seen again, must produce the same key. Campaign parameters and
 * fragments differ between a board listing and the same listing shared on
 * social, so they are dropped; the rest of the query string is kept because
 * job boards routinely put the posting id there.
 */
export function normalizeUrl(input: string): string {
  const raw = (input || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.protocol = "https:";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|mc_cid$|mc_eid$|ref$|source$)/i.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();
    let out = u.toString();
    if (out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return raw.toLowerCase();
  }
}

/** The uniqueness rule: one row per company, per signal type, per source item. */
export function dedupeKey(domain: string, type: string, sourceUrl: string): string {
  return `${normalizeDomain(domain)}|${type.trim().toLowerCase()}|${normalizeUrl(sourceUrl)}`;
}

/**
 * Whole days between the event and `now`. Negative ages (a source claiming a
 * date in the future) are clamped to 0 rather than treated as extra-fresh.
 */
export function ageDays(occurredAt: string, now: Date = new Date()): number | null {
  const t = Date.parse(occurredAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/**
 * Still worth acting on. An unparseable date is NOT live: a signal we cannot
 * date is the stale-posting failure wearing a disguise, and letting it through
 * defeats the point of the window.
 */
export function isLive(type: string, occurredAt: string, now: Date = new Date()): boolean {
  const age = ageDays(occurredAt, now);
  if (age === null) return false;
  return age <= windowDaysFor(type);
}

export interface StackableSignal {
  domain: string;
  type: string;
  occurred_at: string;
}

/**
 * How many *live* signals each company currently carries, counting each signal
 * type once. One signal is a coincidence; the count is what tells a person
 * which account to look at first, and repeats of the same type are the same
 * story rather than a second reason to call.
 */
export function stackCounts(signals: StackableSignal[], now: Date = new Date()): Map<string, number> {
  const perDomain = new Map<string, Set<string>>();
  for (const s of signals) {
    if (!isLive(s.type, s.occurred_at, now)) continue;
    const d = normalizeDomain(s.domain);
    if (!d) continue;
    const seen = perDomain.get(d) ?? new Set<string>();
    seen.add(s.type.trim().toLowerCase());
    perDomain.set(d, seen);
  }
  return new Map([...perDomain].map(([d, types]) => [d, types.size]));
}
