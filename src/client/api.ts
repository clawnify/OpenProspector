// Thin typed wrapper over the app's own API. Every list call is paginated —
// the server clamps limit to 100, so there is no way to ask for the table.
import type { Monitor, MonitorConfig, MonitorEditInput, Observation } from "../shared/monitors";

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
  /** Server-computed: 1 when the lead sat in `running` past the window, so its pass was cut off. */
  stale: number;
  /** Emails this lead held before a later provider replaced them, newest first. Sent by the list. */
  email_older?: OlderFind[];
}

export interface OlderFind {
  value: string;
  verified: number;
  provider_id: string;
  replaced_at: string;
}

export interface Signal {
  id: string;
  domain: string;
  company: string;
  type: string;
  summary: string;
  source: string;
  source_url: string;
  /** When the event happened. Every freshness decision is made against this. */
  occurred_at: string;
  detected_at: string;
  seen_count: number;
  last_seen_at: string;
  status: string;
  dismiss_reason: string;
  run_id: string | null;
  /** Server-computed: null when the source gave a date we could not parse. */
  age_days: number | null;
  /** Server-computed from occurred_at, never stored. */
  live: boolean;
  /** Server-computed: distinct live signal types on this company. */
  stack: number;
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
  /** 'icp' (the agent researches the web) or 'sales_navigator' (icp_prompt is the list URL). */
  source: string;
  /** Contact fields this run buys, e.g. 'email,phone' or 'email'. */
  enrich_fields: string;
  /** 1 when enrichment starts by itself once the list is in. */
  auto_enrich: number;
  /** Set on a re-run a list's refresh started: the search it repeated. */
  refresh_of?: string | null;
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
  /** Fields answered by callback: a lead reaching this vendor for one of them waits instead of resolving in the same pass. */
  deferred?: string[];
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

export type Refresh = "hourly" | "daily" | "weekly" | "off";

/** A list of people that keeps filling from searches and signals. */
export interface ProspectList {
  id: string;
  name: string;
  refresh: Refresh;
  member_count: number;
  verified_count: number;
  email_daily_cap: number | null;
  effective_daily_cap: number;
  lookups_today: number;
  last_refreshed_at: string | null;
  next_refresh_at: string | null;
  created_at: string;
}

export interface ListSource {
  kind: "search" | "signal";
  source_id: string;
  name: string;
  added_at: string;
  missing: boolean;
  last_refresh?: { id: string; status: string; error: string; lead_count: number; created_at: string; stale: number } | null;
  hold?: "working" | "failed" | "stalled" | "undelivered" | null;
  frequency?: string | null;
  active?: boolean | null;
  schedule_error?: string | null;
}

export interface ListConsumer {
  key: string;
  name: string;
  daily: number;
  updated_at: string;
}

export interface ListMember extends Lead {
  added_at: string;
  source_kind: "search" | "signal" | "manual";
  source_id: string;
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
  signalAgents: (page = 1) => req<{ servers: AgentServer[]; page: { has_more: boolean }; selected: string | null }>(`/api/signal-agents?page=${page}`),
  monitors: (page = 1) => req<{ monitors: Monitor[]; total: number; page: number; limit: number }>(`/api/monitors?page=${page}`),
  createMonitor: (id: string, config: MonitorConfig) => req<{ monitor: Monitor }>("/api/monitors", { method: "POST", body: JSON.stringify({ id, ...config }) }),
  editMonitor: (id: string, requestId: string, settings: MonitorEditInput) => req<{ monitor: Monitor }>(`/api/monitors/${id}`, { method: "PUT", body: JSON.stringify({ request_id: requestId, ...settings }) }),
  toggleMonitor: (id: string, active: boolean) => req<{ monitor: Monitor }>(`/api/monitors/${id}`, { method: "PATCH", body: JSON.stringify({ active }) }),
  runMonitor: (monitor: string, id: string) => req<{ check: { id: string; status: string } }>(`/api/monitors/${monitor}/run`, { method: "POST", body: JSON.stringify({ id }) }),
  interruptCheck: (id: string) => req<{ ok: boolean }>(`/api/monitor-checks/${id}/interrupt`, { method: "POST" }),
  observations: (page = 1) => req<{ observations: Observation[]; total: number; page: number; limit: number }>(`/api/monitor-observations?page=${page}`),
  promoteObservation: (id: string) => req<{ lead_id: string }>(`/api/monitor-observations/${id}/lead`, { method: "POST" }),
  providers: (withCredits = false) =>
    req<{ providers: Provider[]; waterfalls: Record<string, string[]>; cache_max_age_days: number }>(
      `/api/providers${withCredits ? "?credits=true" : ""}`,
    ),

  setWaterfall: (field: string, order: string[]) =>
    req<{ field: string; order: string[] }>(`/api/waterfall/${field}`, {
      method: "PUT",
      body: JSON.stringify({ order }),
    }),

  signals: (params: { live?: boolean; status?: string; page?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.live) q.set("live", "true");
    if (params.status) q.set("status", params.status);
    if (params.page) q.set("page", String(params.page));
    const qs = q.toString();
    return req<{ signals: Signal[]; total: number; page: number; limit: number }>(`/api/signals${qs ? `?${qs}` : ""}`);
  },

  dismissSignal: (id: string, dismiss_reason: string) =>
    req<{ signal: Signal }>(`/api/signals/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "dismissed", dismiss_reason }),
    }),

  runFromSignal: (id: string) => req<{ run: Run; signal: Signal }>(`/api/signals/${id}/run`, { method: "POST" }),

  runs: (page = 1, opts: { searchesOnly?: boolean; limit?: number } = {}) =>
    req<{ runs: Run[]; total: number; page: number; limit: number }>(
      `/api/runs?page=${page}${opts.searchesOnly ? "&searches=true" : ""}${opts.limit ? `&limit=${opts.limit}` : ""}`,
    ),

  lists: (page = 1, limit = 25) => req<{ lists: ProspectList[]; total: number; page: number; limit: number }>(`/api/lists?page=${page}&limit=${limit}`),
  list: (id: string) =>
    req<{ list: ProspectList; cap_from: "list" | "consumers" | "none"; sources: ListSource[]; consumers: ListConsumer[] }>(`/api/lists/${id}`),
  listMembers: (id: string, page = 1) => req<{ members: ListMember[]; total: number; page: number; limit: number }>(`/api/lists/${id}/members?page=${page}`),
  createList: (body: { name: string; refresh?: Refresh; email_daily_cap?: number | null }) =>
    req<{ list: ProspectList }>("/api/lists", { method: "POST", body: JSON.stringify(body) }),
  updateList: (id: string, body: { name?: string; refresh?: Refresh; email_daily_cap?: number | null }) =>
    req<{ list: ProspectList }>(`/api/lists/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteList: (id: string) => req<{ ok: boolean }>(`/api/lists/${id}`, { method: "DELETE" }),
  addListSource: (id: string, kind: "search" | "signal", source_id: string) =>
    req<{ added: number }>(`/api/lists/${id}/sources`, { method: "POST", body: JSON.stringify({ kind, source_id }) }),
  removeListSource: (id: string, kind: "search" | "signal", source_id: string) =>
    req<{ ok: boolean }>(`/api/lists/${id}/sources/${kind}/${encodeURIComponent(source_id)}`, { method: "DELETE" }),
  addToList: (id: string, lead_ids: string[]) =>
    req<{ added: number }>(`/api/lists/${id}/members`, { method: "POST", body: JSON.stringify({ lead_ids }) }),
  refreshList: (id: string) => req<{ started: number; failed: number; lookups: number }>(`/api/lists/${id}/refresh`, { method: "POST" }),

  createRun: (icp_prompt: string) =>
    req<{ run: Run }>("/api/runs", { method: "POST", body: JSON.stringify({ icp_prompt }) }),

  createSalesNavRun: (url: string, include_emails: boolean) =>
    req<{ run: Run }>("/api/runs/sales-navigator", { method: "POST", body: JSON.stringify({ url, include_emails }) }),

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

  /**
   * `refresh` re-buys from the vendors; the default reuses the cache at no cost.
   * Normally queued: the lead comes back `running` and the leads poll picks up
   * the result. Only a deployment without the queue (local dev) answers inline.
   */
  enrichLead: (id: string, refresh = false) =>
    req<{ lead: Lead; queued: true } | { lead: Lead; queued: false; credits_used: number; cached: boolean }>(
      `/api/leads/${id}/enrich${refresh ? "?refresh=true" : ""}`,
      { method: "POST" },
    ),

  /** Replace a found email with one from the next provider that has not answered yet. Always costs credits. */
  nextProvider: (id: string) =>
    req<{ lead: Lead; outcome: "found" | "same" | "none"; provider_id: string | null; asked: number; credits_used: number }>(
      `/api/leads/${id}/next-provider`,
      { method: "POST" },
    ),

  enrichRun: (id: string) =>
    req<{ queued: boolean; pending: number }>(`/api/runs/${id}/enrich`, { method: "POST" }),
};
