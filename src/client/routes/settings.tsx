// Waterfall configuration. Set once, then almost never touched — so it lives
// behind its own route rather than occupying the working surface.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Bot, CircleAlert, Database } from "lucide-react";
import { Badge, Card, Chip, Eyebrow, Favicon, Zone } from "../components/ui";
import { WaterfallCard } from "../components/waterfall";
import { api, type AgentState, type Provider } from "../api";

const FIELDS = ["email", "phone"];

/**
 * Which agent does the sourcing.
 *
 * Only worth a choice when the org runs more than one: with a single agent the
 * platform resolves it and the picker would be a decision with one option. With
 * several it refuses to guess — so without this, every search fails.
 *
 * Loads its own state rather than taking it as a prop: nothing else on the
 * screen needs it, and the working surface shouldn't pay for a platform
 * round-trip it never reads.
 */
function AgentCard() {
  const [state, setState] = useState<AgentState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.agent());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function choose(serverId: string) {
    setSaving(true);
    setError(null);
    try {
      await api.setAgentServer(serverId || null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!state) return null;

  return (
    <Card className="mb-6">
      <Zone>
        <Eyebrow right={state.available ? undefined : "unavailable"}>Sourcing agent</Eyebrow>
        <p className="mt-1.5 text-xs text-muted">
          Searches are handed to your agent, which researches the live web and posts the leads back here. Enrichment
          runs in this app; sourcing never does — it needs a real browser and minutes of runtime.
        </p>

        {!state.available ? (
          <p className="mt-2 text-xs text-muted">
            This deployment can't reach the platform, so searches fall back to a brief you paste into your agent's
            chat. Everything else works unchanged.
          </p>
        ) : !state.reachable ? (
          <p className="mt-2 text-xs text-danger">Couldn't reach the platform to list your agents. Try again shortly.</p>
        ) : state.servers.length === 0 ? (
          <p className="mt-2 text-xs text-warning">No agents in this organization yet.</p>
        ) : state.servers.length === 1 ? (
          <span className="mt-2 inline-flex">
            <Chip>
              <Bot size={11} /> {state.servers[0].name || state.servers[0].id}
            </Chip>
          </span>
        ) : (
          <>
            <select
              value={state.server_id ?? ""}
              disabled={saving}
              onChange={(e) => void choose(e.target.value)}
              className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {/* Empty is a real, invalid state, not a default: with several
                  agents the platform refuses to pick one, so leaving this unset
                  means searches fail until it is chosen. Say so rather than
                  silently defaulting to the first. */}
              <option value="">Choose an agent…</option>
              {state.servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.id}
                  {s.status && s.status !== "ready" ? ` — ${s.status}` : ""}
                </option>
              ))}
            </select>
            {!state.server_id ? (
              <p className="mt-1.5 text-xs text-warning">
                You have more than one agent. Pick the one that should source leads — searches can't start until you
                do.
              </p>
            ) : null}
          </>
        )}

        {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      </Zone>
    </Card>
  );
}

export function Settings({
  providers,
  waterfalls,
  cacheDays,
  onReorder,
}: {
  providers: Provider[];
  waterfalls: Record<string, string[]>;
  cacheDays: number;
  onReorder: (field: string, order: string[]) => void;
}) {
  // Only shipped adapters count towards "configured": a planned vendor has no
  // key to set, so counting it would make the ratio permanently unfinishable.
  const shipped = providers.filter((p) => p.status !== "planned");
  const missing = shipped.filter((p) => !p.configured);

  return (
    <>
      <div className="mb-6">
        <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground">
          <ArrowLeft size={13} /> Back to leads
        </Link>
        <h1 className="mt-2 text-xl font-bold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-sm text-muted">
          Sourcing agent, provider keys, and waterfall order. Configure once — every search uses this.
        </p>
      </div>

      <AgentCard />

      <Card className="mb-6">
        <Zone>
          <Eyebrow right={`${shipped.length - missing.length}/${shipped.length} configured`}>Provider keys</Eyebrow>
          <p className="mt-1.5 text-xs text-muted">
            Keys are read from the platform's secret store, never held by this app. Every provider is optional — the
            waterfall skips any vendor without a key and records it in the attempt log, so gaps are visible rather than
            silent.
          </p>
        </Zone>
        {providers.map((p) => (
          <div key={p.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
            <Favicon domain={p.signup_url} size={14} />
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium">{p.label}</span>
              {/* Visible rather than a title tooltip: a tooltip is unreachable
                  by keyboard and screen reader, and "why can't I use this?" is
                  the only question this row has to answer. */}
              {p.blocked_by ? <span className="block text-xs text-muted">{p.blocked_by}</span> : null}
            </span>
            {/* The key's shape, where it is not just an opaque token. Without
                this a compound secret looks like a normal key and fails at the
                first call with a message the user never sees. */}
            <Chip>{p.status === "planned" ? "—" : (p.key_format ?? p.secret_name)}</Chip>
            {p.status === "planned" ? (
              // No key field, because a key would not make it run. The badge is
              // what keeps the roadmap from reading as a shipped capability.
              <Badge tone="warning">Planned</Badge>
            ) : p.configured ? (
              typeof p.credits_remaining === "number" ? (
                <Badge tone="success">
                  <span className="data">{p.credits_remaining.toLocaleString()}</span> credits
                </Badge>
              ) : (
                <Badge tone="success">Configured</Badge>
              )
            ) : (
              <a href={p.signup_url} target="_blank" rel="noreferrer">
                <Badge tone="warning">
                  <CircleAlert size={11} /> Get a key
                </Badge>
              </a>
            )}
          </div>
        ))}
        <Zone className="bg-sunken/50">
          <Eyebrow>Cache</Eyebrow>
          <p className="mt-1.5 text-xs text-muted">
            Resolved contacts are reused for{" "}
            <span className="data font-medium text-foreground">{cacheDays} days</span>, so the same person is never
            bought twice. Contact data decays as people change jobs, which is why the cache expires rather than growing
            forever.
          </p>
          <span className="mt-2 inline-flex">
            <Chip>
              <Database size={11} /> {cacheDays}-day reuse window
            </Chip>
          </span>
        </Zone>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {FIELDS.map((f) => (
          <WaterfallCard
            key={f}
            field={f}
            order={waterfalls[f] ?? []}
            providers={providers}
            onReorder={(next) => onReorder(f, next)}
          />
        ))}
      </div>
    </>
  );
}
