// The push endpoint POSTs the org's contact data to a caller-supplied URL, so
// checkDestination is a trust boundary, not a convenience. Its failure mode is
// exfiltration or SSRF, which is exactly the kind of thing that looks fine in
// review and is obvious in a test.

import { describe, expect, it } from "vitest";
import {
  checkDestination,
  columnsFor,
  safeHeaders,
  toCsv,
  toLinkedInCompanies,
  toLinkedInContacts,
  pushVerdict,
  EXPORT_COLUMNS,
} from "./export";

describe("checkDestination", () => {
  it("accepts a normal public https endpoint", () => {
    const r = checkDestination("https://hooks.example.com/inbound?k=1");
    expect(r.ok).toBe(true);
  });

  it("rejects http, which would put personal data on the wire in clear text", () => {
    expect(checkDestination("http://hooks.example.com/x")).toMatchObject({ ok: false });
  });

  it.each([
    ["https://localhost/x", "localhost"],
    ["https://api.localhost/x", "localhost subdomain"],
    ["https://printer.local/x", "mDNS .local"],
    ["https://vault.internal/x", ".internal"],
    ["https://metadata.google.internal/x", "cloud metadata by name"],
  ])("rejects %s (%s)", (url) => {
    expect(checkDestination(url)).toMatchObject({ ok: false });
  });

  it.each([
    ["https://127.0.0.1/x", "loopback"],
    ["https://10.1.2.3/x", "private /8"],
    ["https://172.16.0.1/x", "private /12 lower bound"],
    ["https://172.31.255.254/x", "private /12 upper bound"],
    ["https://192.168.1.1/x", "private /16"],
    ["https://169.254.169.254/x", "link-local — the cloud metadata endpoint"],
    ["https://100.64.0.1/x", "carrier-grade NAT"],
    ["https://0.0.0.0/x", "this-network"],
    ["https://[::1]/x", "IPv6 loopback"],
    ["https://[fd00::1]/x", "IPv6 unique-local"],
    ["https://[fe80::1]/x", "IPv6 link-local"],
  ])("rejects %s (%s)", (url) => {
    expect(checkDestination(url)).toMatchObject({ ok: false });
  });

  it("still allows public IPs that merely start with a blocked-looking octet", () => {
    // 172.32.x is public even though 172.16–31 is not — an over-broad rule here
    // would silently break legitimate destinations.
    expect(checkDestination("https://172.32.0.1/x").ok).toBe(true);
    expect(checkDestination("https://100.128.0.1/x").ok).toBe(true);
  });

  it("rejects a malformed URL rather than passing it through", () => {
    expect(checkDestination("not a url")).toMatchObject({ ok: false });
  });
});

describe("safeHeaders", () => {
  it("keeps caller headers like an Authorization bearer", () => {
    expect(safeHeaders({ Authorization: "Bearer abc" })).toEqual({ Authorization: "Bearer abc" });
  });

  it("drops hop-by-hop and Host headers that could reshape the request", () => {
    const out = safeHeaders({ Host: "evil.com", Connection: "keep-alive", "Content-Length": "0", "X-Ok": "1" });
    expect(out).toEqual({ "X-Ok": "1" });
  });

  it("drops header injection attempts rather than forwarding them", () => {
    const out = safeHeaders({ "X-Bad": "a\r\nX-Injected: 1", "X-Fine": "ok" });
    expect(out).toEqual({ "X-Fine": "ok" });
  });

  it("returns an empty object when no headers were supplied", () => {
    expect(safeHeaders(undefined)).toEqual({});
  });
});

describe("toCsv", () => {
  it("quotes fields containing a comma, quote, or newline", () => {
    const csv = toCsv([{ a: 'He said "hi", loudly', b: "line1\nline2", c: "plain" }], ["a", "b", "c"]);
    expect(csv).toContain('"He said ""hi"", loudly"');
    expect(csv).toContain('"line1\nline2"');
    expect(csv).toContain(",plain");
  });

  it("renders null and undefined as empty, not the strings 'null'/'undefined'", () => {
    const csv = toCsv([{ a: null, b: undefined }], ["a", "b"]);
    expect(csv.split("\r\n")[1]).toBe(",");
  });

  it("emits a header row even with no data, so an empty export is still a valid file", () => {
    expect(toCsv([], ["a", "b"])).toBe("a,b\r\n");
  });

  it("exports evidence and source_url, since a list without citations is unauditable", () => {
    expect(EXPORT_COLUMNS).toEqual(expect.arrayContaining(["evidence", "source_url", "email_provider"]));
  });
});

describe("pushVerdict", () => {
  it("accepts 2xx", () => {
    expect(pushVerdict(200).ok).toBe(true);
    expect(pushVerdict(204).ok).toBe(true);
  });

  it.each([301, 302, 303, 307, 308])("refuses %d rather than following it with contact data", (code) => {
    const v = pushVerdict(code);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/redirect/i);
  });

  it("reports other failures with the status so the user can act", () => {
    expect(pushVerdict(401)).toMatchObject({ ok: false, error: "Destination returned HTTP 401" });
    expect(pushVerdict(500)).toMatchObject({ ok: false, error: "Destination returned HTTP 500" });
  });
});

// ── LinkedIn Matched Audiences ──────────────────────────────────────
//
// The header row is a contract with LinkedIn Campaign Manager's importer, which
// rejects a file whose header does not match its template. These assertions are
// transcribed from the template files LinkedIn hands out, so a well-meaning
// tidy-up of the column names fails here rather than in someone's ad account.

describe("LinkedIn export formats", () => {
  const LEADS = [
    {
      full_name: "Ada Lovelace",
      title: "Creative Director",
      company: "Acme Studio",
      domain: "acme.com",
      email: "ada@acme.com",
      location: "Amsterdam, Netherlands",
      linkedin_url: "https://www.linkedin.com/in/ada-lovelace/",
    },
    {
      full_name: "Grace Hopper",
      title: "Head of Ops",
      company: "Acme Studio",
      domain: "www.acme.com",
      email: "",
      location: "Austin, Texas, US",
      linkedin_url: "",
    },
  ];

  it("emits LinkedIn's exact contact header", () => {
    const csv = toCsv(toLinkedInContacts(LEADS), columnsFor("linkedin-contacts"));
    expect(csv.split("\r\n")[0]).toBe(
      "email,firstname,lastname,jobtitle,employeecompany,country,googleaid",
    );
  });

  it("emits LinkedIn's exact company header", () => {
    const csv = toCsv(toLinkedInCompanies(LEADS), columnsFor("linkedin-companies"));
    expect(csv.split("\r\n")[0]).toBe(
      "companyname,companywebsite,companyemaildomain,linkedincompanypageurl,stocksymbol,industry,city,state,companycountry,zipcode",
    );
  });

  it("drops contacts with no email, since email is the only thing LinkedIn matches on", () => {
    const rows = toLinkedInContacts(LEADS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: "ada@acme.com",
      firstname: "Ada",
      lastname: "Lovelace",
      jobtitle: "Creative Director",
      employeecompany: "Acme Studio",
      country: "Netherlands",
      googleaid: "",
    });
  });

  it("splits a three-part location into city, state and country", () => {
    const rows = toLinkedInCompanies([LEADS[1]]);
    expect(rows[0]).toMatchObject({ city: "Austin", state: "Texas", companycountry: "US" });
  });

  it("never puts a personal profile URL in the company-page column", () => {
    const rows = toLinkedInCompanies(LEADS);
    expect(rows.every((r) => r.linkedincompanypageurl === "")).toBe(true);
  });

  it("deduplicates companies across www and bare domains", () => {
    const rows = toLinkedInCompanies(LEADS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyname: "Acme Studio",
      companywebsite: "https://acme.com",
      companyemaildomain: "acme.com",
    });
  });

  it("skips leads carrying neither a company name nor a domain", () => {
    expect(toLinkedInCompanies([{ full_name: "Nobody", company: "", domain: "" }])).toHaveLength(0);
  });

  it("keeps a single-token name in firstname rather than dropping it", () => {
    const rows = toLinkedInContacts([{ full_name: "Prince", email: "p@x.com" }]);
    expect(rows[0]).toMatchObject({ firstname: "Prince", lastname: "" });
  });
});
