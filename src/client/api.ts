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
  /** "planned" vendors are declared but have no adapter — the runner never calls them. */
  status: "available" | "planned";
  /** Shape of the secret when it is not an opaque key, e.g. Forager's `accountId:apiKey`. */
  key_format?: string;
  /** Why a planned vendor is not shipped yet. */
  blocked_by?: string;
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

export interface AgentServer {
  id: string;
  name: string | null;
  status: string | null;
}

export interface AgentState {
  /** False off-platform — the app then falls back to a copyable brief. */
  available: boolean;
  /** False when the platform didn't answer. Distinct from having no agents. */
  reachable: boolean;
  server_id: string | null;
  servers: AgentServer[];
}

/**
 * Carries the response body, not just its message. A failed dispatch returns the
 * brief the user can hand over by hand and, when the org has several agents, the
 * list to choose from — losing that on the way up would cost a second call.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError((body.error as string) || `Request failed (${res.status})`, res.status, body);
  }
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

  /** Hand a run to the agent. Throws an ApiError carrying `brief` when it fails. */
  dispatchRun: (id: string) =>
    req<{ dispatched: boolean; task_id: string; server_id: string | null; duplicate: boolean }>(
      `/api/runs/${id}/dispatch`,
      { method: "POST" },
    ),

  agent: () => req<AgentState>("/api/agent"),

  setAgentServer: (server_id: string | null) =>
    req<{ server_id: string | null }>("/api/agent", {
      method: "PUT",
      body: JSON.stringify({ server_id: server_id ?? "" }),
    }),

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
