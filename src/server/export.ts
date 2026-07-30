// Export + push. The app's job ends at a verified contact record; getting it
// into a CRM or a sequencer is a handoff, not a feature we own.

/** RFC 4180 field escaping — quotes doubled, and anything with a delimiter quoted. */
function csvField(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const head = columns.map(csvField).join(",");
  const body = rows.map((r) => columns.map((c) => csvField(r[c])).join(",")).join("\r\n");
  return rows.length ? `${head}\r\n${body}\r\n` : `${head}\r\n`;
}

export const EXPORT_COLUMNS = [
  "full_name",
  "title",
  "company",
  "domain",
  "email",
  "email_verified",
  "email_provider",
  "phone",
  "phone_verified",
  "phone_provider",
  "location",
  "linkedin_url",
  "source",
  "source_url",
  "evidence",
  "enrich_status",
  "created_at",
];

/**
 * Hosts we refuse to push to. The push endpoint POSTs the org's contact data to
 * a caller-supplied URL, so it is an SSRF/exfiltration surface: an agent that
 * read a malicious instruction, or a mistyped destination, must not be able to
 * aim it at link-local metadata or a private network. Validated at the boundary
 * rather than trusted from the caller.
 */
const BLOCKED_HOSTNAME =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

/** Literal IPs in ranges that are never a legitimate customer destination. */
function isBlockedIp(host: string): boolean {
  // IPv6 loopback / unique-local / link-local, bracketed or bare.
  const v6 = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80:")) return true;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, Number(m[2]), Number(m[3]), Number(m[4])].some((n) => n > 255)) return true; // malformed → refuse
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export function checkDestination(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Destination is not a valid URL" };
  }
  // https only: this payload is personal data, and http would put it on the wire
  // in clear text.
  if (url.protocol !== "https:") return { ok: false, reason: "Destination must use https" };
  if (BLOCKED_HOSTNAME.test(url.hostname) || isBlockedIp(url.hostname)) {
    return { ok: false, reason: "Destination host is not routable on the public internet" };
  }
  return { ok: true, url };
}

/**
 * Verdict on the destination's response. Extracted from the route so the 3xx
 * rule is unit-testable: public echo services make a live redirect test
 * unreliable, and an untested security branch is one that silently rots.
 */
export function pushVerdict(status: number): { ok: boolean; error?: string } {
  // Following a redirect would let a permitted host bounce the payload onward
  // to one checkDestination already rejected, so a 3xx is a refusal, not a hop.
  if (status >= 300 && status < 400) {
    return { ok: false, error: "Destination redirected; refusing to follow it with contact data" };
  }
  if (status < 200 || status >= 300) return { ok: false, error: `Destination returned HTTP ${status}` };
  return { ok: true };
}

/**
 * Header names the caller may not set. Hop-by-hop headers and Host would let a
 * caller reshape the request in ways the destination check can't see.
 */
const BLOCKED_HEADER = /^(host|content-length|connection|transfer-encoding|upgrade)$/i;

export function safeHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (BLOCKED_HEADER.test(k)) continue;
    // A newline in a header value is header injection; drop the pair entirely.
    if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) continue;
    out[k] = v;
  }
  return out;
}
