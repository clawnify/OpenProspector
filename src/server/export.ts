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

// ── LinkedIn Matched Audiences ──────────────────────────────────────
//
// LinkedIn accepts a list upload in two fixed shapes, and rejects the file if
// the header row does not match. The columns below are transcribed from the
// template files LinkedIn Campaign Manager hands you on the "Upload a list"
// screen, header order included — it is a contract with someone else's
// importer, so it is a literal, not a mapping we are free to tidy.

/** Contact list: LinkedIn matches on email. Everything else only aids matching. */
export const LINKEDIN_CONTACT_COLUMNS = [
  "email",
  "firstname",
  "lastname",
  "jobtitle",
  "employeecompany",
  "country",
  "googleaid",
];

/** Company list: LinkedIn matches on name, website, or email domain. */
export const LINKEDIN_COMPANY_COLUMNS = [
  "companyname",
  "companywebsite",
  "companyemaildomain",
  "linkedincompanypageurl",
  "stocksymbol",
  "industry",
  "city",
  "state",
  "companycountry",
  "zipcode",
];

export type ExportFormat = "leads" | "linkedin-contacts" | "linkedin-companies";

export function columnsFor(format: ExportFormat): string[] {
  if (format === "linkedin-contacts") return LINKEDIN_CONTACT_COLUMNS;
  if (format === "linkedin-companies") return LINKEDIN_COMPANY_COLUMNS;
  return EXPORT_COLUMNS;
}

/**
 * Split a sourced full name into the two parts LinkedIn asks for.
 *
 * Everything after the first token is the surname, which is right for
 * "Ada Lovelace" and for "Maria del Carmen Rodriguez", and wrong for a name
 * carrying a middle name. LinkedIn treats both fields as matching *hints*
 * alongside the email, so a mis-split costs nothing; dropping the name would.
 */
function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/**
 * Best-effort city / region / country from the free-text `location` a sourcing
 * agent wrote. "Amsterdam, Netherlands" and "Austin, Texas, US" are the shapes
 * that actually turn up. Deliberately not clever: an unparseable location
 * yields empty cells rather than a guess, because a wrong country column makes
 * LinkedIn discard the row silently.
 */
function splitLocation(location: string): { city: string; state: string; country: string } {
  const parts = location.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { city: "", state: "", country: "" };
  if (parts.length === 1) return { city: "", state: "", country: parts[0] };
  if (parts.length === 2) return { city: parts[0], state: "", country: parts[1] };
  return { city: parts[0], state: parts[1], country: parts[parts.length - 1] };
}

/**
 * One CSV row per lead that carries an email.
 *
 * Rows without one are dropped rather than exported blank: email is the only
 * field LinkedIn actually matches a contact on, so a row without it is not a
 * weaker match, it is not a match at all — and it still counts against the
 * audience-size floor that decides whether the audience is usable.
 */
export function toLinkedInContacts(leads: Record<string, unknown>[]): Record<string, unknown>[] {
  return leads
    .filter((l) => String(l.email || "").trim())
    .map((l) => {
      const { first, last } = splitName(String(l.full_name || ""));
      const { country } = splitLocation(String(l.location || ""));
      return {
        email: String(l.email).trim().toLowerCase(),
        firstname: first,
        lastname: last,
        jobtitle: String(l.title || ""),
        employeecompany: String(l.company || ""),
        country,
        // Google Advertising ID: a mobile-app identifier this app never sees.
        // The column has to exist for LinkedIn's importer; the value cannot.
        googleaid: "",
      };
    });
}

/**
 * One CSV row per distinct company across the leads.
 *
 * Deduped on email domain, falling back to the lowercased company name — a
 * company list with the same account fifty times over is how you burn the
 * upload's row budget on one account.
 *
 * `linkedincompanypageurl` is always empty, and that is deliberate: the only
 * LinkedIn URL a lead carries is the *person's* profile, and putting a personal
 * profile in a company-page column would either be rejected or match the wrong
 * entity. `stocksymbol`, `industry` and `zipcode` are empty for the same
 * reason — this app does not source them, and a fabricated value is worse than
 * an absent one.
 */
export function toLinkedInCompanies(leads: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];

  for (const l of leads) {
    const domain = String(l.domain || "").trim().toLowerCase().replace(/^www\./, "");
    const name = String(l.company || "").trim();
    if (!domain && !name) continue;

    const key = domain || name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const { city, state, country } = splitLocation(String(l.location || ""));
    out.push({
      companyname: name,
      companywebsite: domain ? `https://${domain}` : "",
      companyemaildomain: domain,
      linkedincompanypageurl: "",
      stocksymbol: "",
      industry: "",
      city,
      state,
      companycountry: country,
      zipcode: "",
    });
  }
  return out;
}

/** Rows in the shape `format` expects, from raw lead rows. */
export function toExportRows(
  format: ExportFormat,
  leads: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (format === "linkedin-contacts") return toLinkedInContacts(leads);
  if (format === "linkedin-companies") return toLinkedInCompanies(leads);
  return leads;
}
