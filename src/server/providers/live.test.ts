// Live reachability check — opt-in, and off by default.
//
//   LIVE_PROVIDER_CHECK=1 pnpm test
//
// The rest of the suite stubs fetch, because response *mapping* is what can be
// tested without a paid key at fourteen vendors. But mapping is not the only
// thing that breaks. The other half is the **invocation contract** — the host,
// the path, the API version, the auth header name — and that half is invisible
// to a stubbed test: a stub happily answers an adapter pointed at a v6 endpoint
// that was retired, or sending a header the vendor has never heard of.
//
// So this calls every adapter against the real vendor with a deliberately
// invalid key. It costs nothing (no credit is spent on a rejected request) and
// it asserts the one thing that proves the request was well-formed: the vendor
// got far enough to reject the *key*. A wrong path or version answers 404, a
// wrong parameter shape answers 400, and either way the outcome is not
// `unconfigured` and this fails.
//
// It is gated rather than deleted because it has already earned its place: it
// caught Tomba answering a bad key with HTTP 400 and an `errors.type` body
// instead of a 401, which the shared status mapping reported as a broken
// vendor rather than a rejected key.
//
// Not part of CI: it depends on fourteen third-party APIs being up, and a test
// that fails for someone else's outage stops being read.

import { describe, expect, it } from "vitest";
import { REGISTRY } from "./index";
import type { EnrichField, EnrichProvider } from "./types";

const LEAD = {
  fullName: "Ada Lovelace",
  firstName: "Ada",
  lastName: "Lovelace",
  domain: "stripe.com",
  company: "Stripe",
  email: "ada@stripe.com",
  linkedinUrl: "https://www.linkedin.com/in/ada-lovelace/",
};

/** Compound-secret vendors still need a well-formed value to get past their own parsing. */
function bogusKey(p: EnrichProvider): string {
  return p.keyFormat ? "bogus-id:bogus-key" : "bogus-key-that-is-not-real";
}

// Declared locally rather than pulling in @types/node: this is the only place
// in the app that reads an ambient env var, and the worker runtime has no
// `process` to type against.
declare const process: { env: Record<string, string | undefined> };

const suite = process.env.LIVE_PROVIDER_CHECK ? describe : describe.skip;

suite("live vendor reachability", () => {
  for (const provider of REGISTRY) {
    for (const field of provider.fields) {
      it(
        `${provider.id} reaches its ${field} endpoint and rejects a bad key`,
        async () => {
          // A transport failure (dead host, refused TLS handshake) rejects out
          // of fetch rather than returning a status, so it is caught here and
          // named. Reported as an opaque "fetch failed" it reads as a flaky
          // test; reported as "endpoint unreachable" it reads as what it is —
          // a shipped vendor nobody can call.
          let r: Awaited<ReturnType<typeof provider.find>>;
          try {
            // Deferred fields refuse to run without a callback URL — before any
            // request — so one is supplied; the bad key still stops the vendor
            // from ever calling it.
            r = await provider.find(field as EnrichField, LEAD, bogusKey(provider), {
              callbackUrl: "https://example.com/api/callbacks/00000000-0000-4000-8000-000000000000",
            });
          } catch (err) {
            throw new Error(
              `${provider.id}/${field}: endpoint unreachable (${err instanceof Error ? err.message : String(err)})`,
            );
          }
          // `unconfigured` is the runner's word for "this vendor is unusable
          // until the key is fixed" — which is exactly what a bogus key means.
          // Anything else (`error`, `ineligible`, a `hit`) means the request
          // never landed the way the adapter thinks it does.
          expect(r.outcome, `${provider.id}/${field}: ${r.detail ?? "no detail"}`).toBe("unconfigured");
          expect(r.creditsUsed, `${provider.id}/${field} spent credits on a rejected key`).toBe(0);
        },
        30_000,
      );
    }
  }
});
