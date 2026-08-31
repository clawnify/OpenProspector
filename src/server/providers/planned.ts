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
 * Zeliq is the one vendor in the roadmap this app cannot currently adapt, and
 * the reason is structural rather than unfinished work.
 *
 * Both of its enrichment endpoints (`/contact/enrich/email` and
 * `/contact/enrich/phone`) mark `callback_url` as **required** and deliver the
 * result only as a webhook POST, minutes later, with retries backing off for
 * over an hour. There is no synchronous mode. Every other vendor here answers
 * in the same request.
 *
 * The waterfall runner is synchronous by necessity: it decides whether to spend
 * a credit at the next vendor based on whether this one resolved the field, so
 * it cannot proceed without an answer. Supporting Zeliq therefore is not an
 * adapter — it is a second, deferred execution path (a pending-enrichment
 * table, a public callback route with its own token, and out-of-band lead and
 * ledger writes). That is a deliberate feature, not a line in a registry, so it
 * is recorded here rather than half-built.
 */
export const PLANNED: readonly PlannedProvider[] = [
  {
    id: "zeliq",
    label: "Zeliq",
    fields: ["email", "phone"],
    homepage: "https://zeliq.com",
    blockedBy: "Webhook-only API — needs a deferred enrichment path, not an adapter",
  },
];

/** Planned ids for one field, in intended waterfall position. */
export function plannedForField(field: EnrichField): PlannedProvider[] {
  return PLANNED.filter((p) => p.fields.includes(field));
}
