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
}

/**
 * Order within each field is the intended default waterfall position, not an
 * arbitrary list. Phone runs deeper than email because phone credits cost
 * multiples of an email at every vendor, so falling through more providers
 * before giving up is worth it.
 */
export const PLANNED: readonly PlannedProvider[] = [
  { id: "leadmagic", label: "LeadMagic", fields: ["email", "phone"], homepage: "https://leadmagic.io" },
  { id: "wiza", label: "Wiza", fields: ["email", "phone"], homepage: "https://wiza.co" },
  { id: "peopledatalabs", label: "People Data Labs", fields: ["email", "phone"], homepage: "https://peopledatalabs.com" },
  { id: "prospeo", label: "Prospeo", fields: ["email", "phone"], homepage: "https://prospeo.io" },
  { id: "bytemine", label: "Bytemine", fields: ["phone"], homepage: "https://bytemine.io" },
  { id: "forager", label: "Forager", fields: ["phone"], homepage: "https://forager.ai" },
  { id: "contactout", label: "ContactOut", fields: ["phone"], homepage: "https://contactout.com" },
  { id: "zeliq", label: "Zeliq", fields: ["phone"], homepage: "https://zeliq.com" },
];

/** Planned ids for one field, in intended waterfall order. */
export function plannedForField(field: EnrichField): PlannedProvider[] {
  const ORDER: Record<EnrichField, string[]> = {
    // Findymail is position 1 and already implemented, so it is not listed here.
    email: ["leadmagic", "wiza", "peopledatalabs", "prospeo"],
    phone: ["bytemine", "peopledatalabs", "leadmagic", "wiza", "forager", "prospeo", "contactout", "zeliq"],
  };
  return ORDER[field]
    .map((id) => PLANNED.find((p) => p.id === id))
    .filter((p): p is PlannedProvider => Boolean(p));
}
