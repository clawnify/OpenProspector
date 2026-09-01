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
 * Vendors we researched, could not adapt, and the structural reason why.
 *
 * All but one share a single blocker, and it is worth naming once: **their
 * enrichment API does not answer in the same request.** You POST, you get an
 * id, and the result arrives later by webhook or by polling. The waterfall
 * runner is synchronous by necessity — it decides whether to spend a credit at
 * the next vendor based on whether this one resolved the field, so it cannot
 * proceed without an answer in-band.
 *
 * Supporting any of them is therefore not an adapter, it is a second execution
 * path: a pending-enrichment table, a public callback route with its own token,
 * and out-of-band lead and ledger writes. That is one deferred feature that
 * would unlock this whole list at once, which is exactly why they are recorded
 * together rather than each half-built.
 */
export const PLANNED: readonly PlannedProvider[] = [
  {
    id: "dropcontact",
    label: "Dropcontact",
    fields: ["email"],
    homepage: "https://www.dropcontact.com",
    blockedBy: "Batch-only API — POST returns a request id, results fetched by a later GET",
  },
  {
    id: "rocketreach",
    label: "RocketReach",
    fields: ["email", "phone"],
    homepage: "https://rocketreach.co",
    blockedBy: "Lookups return `searching`/`waiting` and complete out of band — needs polling or a webhook",
  },
  {
    id: "surfe",
    label: "Surfe",
    fields: ["email", "phone"],
    homepage: "https://www.surfe.com",
    blockedBy: "Enrichment returns an enrichmentID immediately; results come by polling or webhook",
  },
  {
    id: "snov",
    label: "Snov.io",
    fields: ["email"],
    homepage: "https://snov.io",
    blockedBy: "Task-based API — POST to /start returns a task_hash, result fetched from /result",
  },
  {
    id: "zeliq",
    label: "Zeliq",
    fields: ["email", "phone"],
    homepage: "https://zeliq.com",
    blockedBy: "Webhook-only API — `callback_url` is required and there is no synchronous mode",
  },
  {
    id: "kaspr",
    label: "Kaspr",
    fields: ["email", "phone"],
    homepage: "https://www.kaspr.io",
    // The odd one out: Kaspr is synchronous and self-serve, so it is not blocked
    // by the deferred path above. What is missing is the contract. Its request
    // is documented (POST https://api.developers.kaspr.io/profile/linkedin, an
    // Authorization header plus `accept-version: v2.0`, body `{ name, id }`),
    // but its response schema is not published anywhere retrievable — the
    // Stoplight reference renders client-side and the developer docs host does
    // not respond. Writing the mapping would mean guessing which field holds
    // the work email and which holds the mobile, and a wrong guess here reads
    // as "Kaspr never has data for anyone" rather than as a bug. It needs one
    // live call against a real key to pin, and then it is a normal adapter.
    blockedBy: "Response schema not publicly documented — needs one live call against a real key to pin",
  },
];

/** Planned ids for one field, in intended waterfall position. */
export function plannedForField(field: EnrichField): PlannedProvider[] {
  return PLANNED.filter((p) => p.fields.includes(field));
}
