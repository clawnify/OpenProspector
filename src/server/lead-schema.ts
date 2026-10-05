// The lead as the API returns it. Its own module because the leads routes
// (index.ts) and the list routes (list-routes.ts) both answer with it.

import { z } from "@clawnify/app";

export const LeadSchema = z
  .object({
    id: z.string(),
    run_id: z.string().nullable(),
    full_name: z.string(),
    title: z.string(),
    company: z.string(),
    domain: z.string(),
    linkedin_url: z.string(),
    location: z.string(),
    source: z.string(),
    source_url: z.string(),
    evidence: z.string(),
    email: z.string(),
    email_verified: z.number().int(),
    email_provider: z.string(),
    phone: z.string(),
    phone_verified: z.number().int(),
    phone_provider: z.string(),
    enrich_status: z.string(),
    enrich_fields: z.string().nullable().optional().openapi({
      description: "Set to 'email' when a list's automatic lookup took this lead: its waterfall buys emails only. Empty: its search's fields.",
    }),
    created_at: z.string(),
    updated_at: z.string(),
    /**
     * Computed by the server, not stored, the same way a run's `stale` is: a
     * lead still `running` long after anything touched it. Whatever was
     * enriching it died without finishing, so it will not move on its own.
     */
    stale: z.number().int().openapi({
      description: "1 when the lead has sat in `running` past the stranding window: the pass enriching it was cut off. Re-run it with POST /api/leads/{id}/enrich.",
    }),
  })
  .openapi("Lead");
