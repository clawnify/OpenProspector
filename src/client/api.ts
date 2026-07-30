// Thin typed wrapper over the app's own API. Every list call is paginated —
// the server clamps limit to 100, so there is no way to ask for the table.

export interface Lead {
  id: string;
  run_id: string | null;
  full_name: string;
  title: string;
  company: string;
  domain: string;
  linkedin_url: string;
  location: string;
  source: string;
  source_url: string;
  evidence: string;
  email: string;
  email_verified: number;
  email_provider: string;
  phone: string;
  phone_verified: number;
  phone_provider: string;
  enrich_status: string;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  icp_prompt: string;
  status: string;
  lead_count: number;
  credits_spent: number;
  error: string;
  created_at: string;
  updated_at: string;
  /** Server-computed: 1 when a sourcing run has gone quiet past the window. */
  stale: number;
}

export interface Provider {
  id: string;
  label: string;
  fields: string[];
  secret_name: string;
  signup_url: string;
  configured: boolean;
  credits_remaining?: number | null;
}

export interface Attempt {
  provider_id: string;
  field: string;
  outcome: string;
  credits_used: number;
  ms: number;
  detail: string | null;
  created_at: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  providers: (withCredits = false) =>
    req<{ providers: Provider[]; waterfalls: Record<string, string[]>; cache_max_age_days: number }>(
      `/api/providers${withCredits ? "?credits=true" : ""}`,
    ),

  setWaterfall: (field: string, order: string[]) =>
    req<{ field: string; order: string[] }>(`/api/waterfall/${field}`, {
      method: "PUT",
      body: JSON.stringify({ order }),
    }),

  runs: (page = 1) => req<{ runs: Run[]; total: number; page: number; limit: number }>(`/api/runs?page=${page}`),

  createRun: (icp_prompt: string) =>
    req<{ run: Run }>("/api/runs", { method: "POST", body: JSON.stringify({ icp_prompt }) }),

  /** Progress reporting — normally the agent's call, exposed here for the UI's sake. */
  patchRun: (id: string, patch: { status?: string; error?: string }) =>
    req<{ run: Run }>(`/api/runs/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  importLeads: (leads: Partial<Lead>[], run_id?: string) =>
    req<{ imported: number; run_id: string | null }>("/api/leads", {
      method: "POST",
      body: JSON.stringify({ leads, run_id }),
    }),

  leads: (params: { run_id?: string; page?: number; search?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.run_id) qs.set("run_id", params.run_id);
    if (params.search) qs.set("search", params.search);
    qs.set("page", String(params.page ?? 1));
    qs.set("limit", String(params.limit ?? 25));
    return req<{ leads: Lead[]; total: number; page: number; limit: number }>(`/api/leads?${qs}`);
  },

  lead: (id: string) => req<{ lead: Lead; attempts: Attempt[] }>(`/api/leads/${id}`),

  /** `refresh` re-buys from the vendors; the default reuses the cache at no cost. */
  enrichLead: (id: string, refresh = false) =>
    req<{ lead: Lead; credits_used: number; cached: boolean }>(
      `/api/leads/${id}/enrich${refresh ? "?refresh=true" : ""}`,
      { method: "POST" },
    ),

  enrichRun: (id: string) =>
    req<{ queued: boolean; pending: number }>(`/api/runs/${id}/enrich`, { method: "POST" }),
};
