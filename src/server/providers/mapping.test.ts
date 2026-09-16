// Real-key mapping check — opt-in, off by default, and it SPENDS CREDITS.
//
//   set -a; source .dev.vars; set +a
//   LIVE_MAPPING_CHECK=1 npx vitest run src/server/providers/mapping.test.ts
//
// The other half of live.test.ts, and it exists because that file can only ever
// prove half the problem. live.test.ts calls every adapter with a deliberately
// bogus key, which proves the **invocation contract** — host, path, API
// version, auth header — because the vendor got far enough to reject the key.
// What a rejected request can never return is a *record*, so every line of
// response mapping stays unexercised against reality: an adapter reading
// `data.organization.industry` from a vendor that renames it to
// `company.industry` passes live.test.ts, passes the stubbed fixtures in
// company-adapters.test.ts (the fixture was written from the same wrong
// reading), and returns an empty record in production.
//
// Only a real key closes that gap, so this runs the same adapters against the
// real vendor with the real key from .dev.vars, and asserts the things a live
// payload can prove and a fixture cannot.
//
// It is gated rather than deleted for two reasons, both stronger than the ones
// on live.test.ts: it costs money (one credit per configured vendor, per run),
// and it depends on the operator holding keys that most contributors will not.
// A vendor with no key in the environment is skipped, not failed — the point is
// to verify what you have, and to make the next key you buy one command away
// from verified.

import { describe, expect, it } from "vitest";
import { COMPANY_REGISTRY } from "./company";
import { REGISTRY } from "./index";
import type { CompanyRecord, EnrichField } from "./types";

// Declared locally rather than pulling in @types/node, matching live.test.ts:
// these two files are the only places in the app that read an ambient env var,
// and the worker runtime has no `process` to type against.
declare const process: { env: Record<string, string | undefined> };

const suite = process.env.LIVE_MAPPING_CHECK ? describe : describe.skip;

/** A vendor with no key configured is skipped, not failed. */
function keyFor(secretName: string): string | undefined {
  const v = process.env[secretName]?.trim();
  return v ? v : undefined;
}

// ── Company mapping ─────────────────────────────────────────────────
//
// The company probe needs no configuration and carries no personal data: its
// subject is a *company*, and stripe.com is in every firmographic database
// worth shipping an adapter for. That makes it the half of this file that runs
// for free the moment any key is present.

const COMPANY_DOMAIN = "stripe.com";

/**
 * Per-field sanity, expressed as what a *wrong* mapping produces.
 *
 * These are not style checks. Each one is a real failure mode seen in this
 * class of API: a headcount range delivered as the string "1000-5000" where the
 * schema says integer, a founding year that is actually a unix timestamp, and —
 * the most common of all — a vendor's *person* profile URL mapped into the
 * company's `linkedinUrl`, which then exports an audience LinkedIn rejects.
 */
const FIELD_SANITY: Partial<Record<keyof CompanyRecord, (v: unknown) => string | null>> = {
  employeeCount: (v) =>
    typeof v === "number" && Number.isInteger(v) && v > 0
      ? null
      : `employeeCount should be a positive integer, got ${JSON.stringify(v)}`,
  foundedYear: (v) =>
    typeof v === "number" && v >= 1600 && v <= new Date().getFullYear()
      ? null
      : `foundedYear should be a plausible year, got ${JSON.stringify(v)}`,
  linkedinUrl: (v) =>
    typeof v === "string" && v.includes("linkedin.com") && !v.includes("/in/")
      ? null
      : `linkedinUrl should be a company page, not a person profile, got ${JSON.stringify(v)}`,
};

suite("live company mapping", () => {
  for (const provider of COMPANY_REGISTRY) {
    const apiKey = keyFor(provider.secretName);
    const t = apiKey ? it : it.skip;

    t(
      `${provider.id} maps a real ${COMPANY_DOMAIN} response`,
      async () => {
        const r = await provider.enrich(COMPANY_DOMAIN, apiKey as string);

        // `miss` is allowed — coverage is a vendor's business, not a bug in the
        // adapter. `error` and `unconfigured` are not: with a real key against a
        // company this well known, both mean the request or the key is wrong.
        expect(
          ["hit", "miss", "no_credits"],
          `${provider.id}: ${r.outcome} — ${r.detail ?? "no detail"}`,
        ).toContain(r.outcome);
        if (r.outcome !== "hit") return;

        const data = r.data;
        expect(data, `${provider.id} reported a hit with no data`).toBeTruthy();

        const filled = Object.entries(data as CompanyRecord)
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k]) => k as keyof CompanyRecord);

        // A hit that mapped nothing is the exact bug this file exists to catch:
        // the request landed, the vendor answered, and every field name in the
        // adapter missed. A stubbed fixture cannot tell you this.
        expect(filled.length, `${provider.id} returned a hit that mapped zero fields`).toBeGreaterThan(0);

        // `covers` is the adapter's own declaration of what it can return, and
        // the runner *spends money* on it: a vendor whose covers set is already
        // filled is skipped without being called. Returning a field outside it
        // means the declaration is wrong, and the runner's skip logic is making
        // its decisions on a false list.
        const outside = filled.filter((k) => !provider.covers.includes(k));
        expect(outside, `${provider.id} returned fields it does not declare in covers`).toEqual([]);

        const problems = filled
          .map((k) => FIELD_SANITY[k]?.((data as CompanyRecord)[k]) ?? null)
          .filter((m): m is string => m !== null);
        expect(problems, `${provider.id}: ${problems.join("; ")}`).toEqual([]);

        // Reported, never asserted. A field declared in `covers` and absent from
        // one company's answer is usually that company (Stripe has no ticker),
        // not drift — one sample cannot tell the two apart. But a vendor that
        // returns *nothing* it declared is drift every time, and this is the
        // line that shows it to whoever is reading the run.
        const missing = provider.covers.filter((k) => !filled.includes(k));
        console.info(
          `[mapping] ${provider.id}: mapped ${filled.length}/${provider.covers.length} declared fields` +
            (missing.length ? ` — absent: ${missing.join(", ")}` : "") +
            ` (${r.creditsUsed} credit${r.creditsUsed === 1 ? "" : "s"})`,
        );
      },
      30_000,
    );
  }
});

// ── Person mapping ──────────────────────────────────────────────────
//
// Unlike a company, a person probe needs a *person*, and no real one belongs
// hardcoded in an open-source repo that queries fourteen contact-data vendors
// with it. So the lead comes from the environment and the whole block skips
// without it:
//
//   LIVE_MAPPING_LEAD="Ada Lovelace,stripe.com"
//   LIVE_MAPPING_LEAD="Ada Lovelace,stripe.com,https://www.linkedin.com/in/…"
//
// The LinkedIn URL is worth supplying: several vendors key their phone lookup
// off a profile URL and will report `ineligible` without one, which tells you
// nothing about their mapping.

function parseLead() {
  const raw = process.env.LIVE_MAPPING_LEAD?.trim();
  if (!raw) return null;
  const [fullName, domain, linkedinUrl] = raw.split(",").map((s) => s.trim());
  if (!fullName || !domain) return null;
  const [firstName, ...rest] = fullName.split(/\s+/);
  return {
    fullName,
    firstName,
    lastName: rest.join(" "),
    domain,
    linkedinUrl: linkedinUrl || undefined,
  };
}

const LEAD = parseLead();

/** Deliberately loose — this checks the adapter mapped an address, not that it parses RFC 5322. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Digits, with the punctuation vendors disagree about stripped. */
const PHONE = /^\+?[\d\s().-]{7,}$/;

suite("live person mapping", () => {
  for (const provider of REGISTRY) {
    for (const field of provider.fields) {
      const apiKey = keyFor(provider.secretName);
      const t = apiKey && LEAD ? it : it.skip;

      t(
        `${provider.id} maps a real ${field} response`,
        async () => {
          const lead = LEAD as NonNullable<typeof LEAD>;
          // The email waterfall feeds the phone one in production, so a phone
          // probe gets the same input it would have there.
          const r = await provider.find(field as EnrichField, lead, apiKey as string, {
            callbackUrl: "https://example.com/api/callbacks/00000000-0000-4000-8000-000000000000",
          });

          expect(
            ["hit", "miss", "ineligible", "no_credits", "pending"],
            `${provider.id}/${field}: ${r.outcome} — ${r.detail ?? "no detail"}`,
          ).toContain(r.outcome);
          if (r.outcome !== "hit") {
            console.info(`[mapping] ${provider.id}/${field}: ${r.outcome} — ${r.detail ?? ""}`);
            return;
          }

          expect(r.value, `${provider.id}/${field} reported a hit with a null value`).toBeTruthy();
          const pattern = field === "email" ? EMAIL : PHONE;
          expect(
            pattern.test(r.value as string),
            `${provider.id}/${field} mapped something that is not a ${field}: ${JSON.stringify(r.value)}`,
          ).toBe(true);
          console.info(
            `[mapping] ${provider.id}/${field}: hit, verified=${r.verified}, ${r.creditsUsed} credit(s)`,
          );
        },
        60_000,
      );
    }
  }
});
