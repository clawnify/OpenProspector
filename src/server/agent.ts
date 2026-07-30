// Handing a sourcing run to the org's agent.
//
// The split this app is built on: it owns *enrichment* — high volume,
// mechanical, a bounded HTTP call per lead, so it runs here in a Worker. It does
// not own *sourcing*, which needs judgment, a real browser and minutes of
// runtime. That work goes to the org's agent through the platform's `/v1/agents`
// route, which pushes one instruction into the agent and returns.
//
// There is nothing to poll. Delivery is one-way by design: the agent reports
// back through this app's own API (`PATCH /api/runs/{id}`, `POST /api/leads`),
// which is why the runs table — not the platform — is the record of progress.

/** Platform route that delivers a task to the org's agent. */
const DEFAULT_AGENTS_URL = "https://provision.clawnify.com/v1/agents";

export interface AgentEnv {
  /** Minted per org by the platform. Absent off-platform (`pnpm dev`). */
  CLAWNIFY_TOKEN?: string;
  /** Override for local testing against a dev API. */
  CLAWNIFY_AGENTS_URL?: string;
}

export interface AgentServer {
  id: string;
  name: string | null;
  status: string | null;
}

/**
 * Dispatch outcome as a value rather than an exception, so a caller cannot
 * forget the failure path — every failure here has a user-facing fallback
 * (show the brief, or ask them to pick a server), not a stack trace.
 */
export type DispatchResult =
  | { ok: true; taskId: string; serverId: string | null; duplicate: boolean }
  | { ok: false; error: string; servers?: AgentServer[] };

function base(env: AgentEnv): string {
  return (env.CLAWNIFY_AGENTS_URL ?? DEFAULT_AGENTS_URL).replace(/\/+$/, "");
}

/**
 * Whether this deployment can reach the platform at all. False off-platform,
 * where the app still works — the user hands the brief over by hand instead.
 */
export function dispatchAvailable(env: AgentEnv): boolean {
  return Boolean(env.CLAWNIFY_TOKEN);
}

async function call(
  env: AgentEnv,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLAWNIFY_TOKEN}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    // The platform forwards to a VPS with its own 15s timeout; this bounds the
    // whole hop so a wedged box can't hold a user-facing request open.
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

/**
 * Agent servers this org can hand work to. Null — not an empty array — when the
 * app cannot reach the platform, so "no agents" and "can't tell" stay distinct.
 */
export async function listAgentServers(env: AgentEnv): Promise<AgentServer[] | null> {
  if (!dispatchAvailable(env)) return null;
  try {
    const { status, body } = await call(env, "/servers");
    if (status !== 200) return null;
    return (body.servers as AgentServer[]) ?? [];
  } catch {
    return null;
  }
}

export async function dispatchTask(
  env: AgentEnv,
  opts: { instruction: string; serverId?: string | null; idempotencyKey: string },
): Promise<DispatchResult> {
  if (!dispatchAvailable(env)) {
    return { ok: false, error: "This app can't reach your agent — hand the brief over in chat instead." };
  }

  let status: number;
  let body: Record<string, unknown>;
  try {
    ({ status, body } = await call(env, "/tasks", {
      method: "POST",
      body: JSON.stringify({
        instruction: opts.instruction,
        ...(opts.serverId ? { server_id: opts.serverId } : {}),
        idempotency_key: opts.idempotencyKey,
      }),
    }));
  } catch (err) {
    return { ok: false, error: `Could not reach your agent: ${(err as Error).message}` };
  }

  // 202 = dispatched, 200 = the platform recognised this as a retry of a task it
  // already delivered. Both mean the agent has the work; only one sent it.
  if (status === 202 || status === 200) {
    return {
      ok: true,
      taskId: String(body.task_id ?? ""),
      serverId: (body.server_id as string | null) ?? null,
      duplicate: body.status === "duplicate",
    };
  }

  // The org runs more than one agent and none was chosen. The platform refuses
  // rather than guessing, and hands back the list — pass it through so the user
  // can choose without a second round-trip.
  if (body.error === "multiple_servers") {
    return {
      ok: false,
      error: "You have more than one agent — choose which one sources leads in Settings.",
      servers: (body.servers as AgentServer[]) ?? [],
    };
  }

  const detail = typeof body.detail === "string" ? ` (${body.detail})` : "";
  return { ok: false, error: `${body.error ?? `Agent dispatch failed (${status})`}${detail}` };
}

/**
 * The sourcing instruction — one text with two audiences: it is what the
 * platform delivers to the agent, and what the user copies into chat when
 * dispatch is unavailable. Kept in one place so those can never drift.
 *
 * `appUrl` is this app's own origin, so the agent knows which app to report
 * back to without guessing from the run id.
 */
export function sourcingBrief(opts: { runId: string; prompt: string; appUrl: string }): string {
  return [
    `Find leads matching this ICP and add them to Open Prospector (${opts.appUrl}):`,
    ``,
    `"${opts.prompt}"`,
    ``,
    `Research the live web — maps and review sites for local businesses, job`,
    `boards for hiring signals, funding news and company blogs for growth`,
    `signals, professional profiles for the people themselves.`,
    ``,
    `For every lead include full_name, company, and the bare domain, plus`,
    `evidence (one line on why they qualify) and source_url.`,
    ``,
    `Do NOT look up email addresses or phone numbers — the app buys those`,
    `through its provider waterfall far more cheaply than you can find them.`,
    ``,
    `Report progress with PATCH /api/runs/${opts.runId} ({"status":"sourcing"}`,
    `now, {"status":"done"} when finished, or {"status":"failed","error":"…"}),`,
    `then POST the leads to /api/leads with run_id "${opts.runId}".`,
  ].join("\n");
}
