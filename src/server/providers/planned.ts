// Vendors on the roadmap but not yet implemented.
//
// These are DECLARATIVE ONLY — metadata with no `find()`. They are deliberately
// a separate list from REGISTRY rather than stub adapters in it, so the
// waterfall runner cannot call one even by accident: it resolves ids against
// REGISTRY, and a planned vendor simply isn't there.
//
// They are surfaced in the UI (badged "Planned") because the roadmap is real
// product information — it tells a user what a future key will buy them, and
// shows the intended waterfall depth per field. The badge is what keeps that
// honest: an unlabelled entry would imply a capability we have not shipped.

import type { EnrichField } from "./types";

export interface PlannedProvider {
  id: string;
  label: string;
  fields: readonly EnrichField[];
  /** Homepage — used for the vendor mark and the "learn more" link. */
  homepage: string;
  /** Why it is not shipped, shown next to the badge. */
  blockedBy: string;
}

/**
 * Vendors declared but not callable, and the structural reason why.
 *
 * Every vendor that answers out of band now ships on the deferred path (see
 * `deferred` on EnrichProvider and the callback route), so this list is down
 * to the one whose endpoint itself is gone.
 */
export const PLANNED: readonly PlannedProvider[] = [
  {
    id: "bytemine",
    label: "Bytemine",
    fields: ["email", "phone"],
    homepage: "https://www.bytemine.ai",
    // Parked, not abandoned. This one shipped and its adapter still exists in
    // bytemine.ts with its mapping tests, because the mapping is fine — what
    // broke is the vendor's endpoint.
    //
    // `api.bytemine.ai` is a CNAME onto an AWS API Gateway custom domain, and
    // the gateway now answers TLS alert 40 (handshake_failure) for that SNI
    // name. Isolated to the hostname on 2026-09-01: against the same IP, in the
    // same second, SNI `7w80ki5932.execute-api.us-east-2.amazonaws.com`
    // completes a TLS 1.3 handshake with a valid Amazon certificate while SNI
    // `api.bytemine.ai` is refused. That is API Gateway's signature for a
    // custom domain with no certificate mapped, so it is server-side and
    // client-independent — reproduced from OpenSSL 3.6.3, LibreSSL and workerd.
    // Still failing the same way on 2026-09-02.
    //
    // A vendor in REGISTRY is advertised in settings as available, with a link
    // to its pricing page, so keeping it there invites a user to go and pay for
    // an API that cannot be called. Declaring it is the honest state, and
    // reviving it is one line back into REGISTRY once the handshake succeeds.
    blockedBy: "Vendor endpoint unreachable since 2026-09-01 — api.bytemine.ai has no TLS certificate mapped",
  },
];

/** Planned ids for one field, in intended waterfall position. */
export function plannedForField(field: EnrichField): PlannedProvider[] {
  return PLANNED.filter((p) => p.fields.includes(field));
}
