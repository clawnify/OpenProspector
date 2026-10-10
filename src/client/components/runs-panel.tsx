// Sourcing runs. Without this the app fires a task at the agent and then shows
// nothing for minutes — the agent works in an isolated session with
// deliver:false, so the app is the only place progress can surface.
//
// Only the searches someone started. The runs that start by themselves show
// where they come from: a signal's search for the people at a company it
// found, on Signals under that company; a list's re-runs, on the list.

import { AlertTriangle, Check, Compass, Loader2, Search, X } from "lucide-react";
import { Badge, Button, Card, CardTitle, Chip, Empty, Zone } from "./ui";
import type { Run } from "../api";

/** What the table is filtered to, in words. `null` while the run is still loading. */
export function runFilterLabel(run: Run | null): string {
  if (!run) return "Leads from one search";
  if (run.company_domain) return `People found at ${run.company_domain}`;
  if (run.source === "sales_navigator") return "Leads from a Sales Navigator export";
  return `Leads from “${run.icp_prompt}”`;
}

/**
 * The run filter, as a pill in the table's filter bar. The run may not be a
 * row in Searches (a company search, opened from Signals), so a row's own
 * toggle can't be the only way back to every lead.
 */
export function RunFilter({ run, onClear }: { run: Run | null; onClear: () => void }) {
  const label = runFilterLabel(run);
  return (
    <span className="inline-flex h-7 min-w-0 max-w-xs items-center rounded-sm bg-card pl-2.5 text-sm font-medium shadow-raised">
      <span className="truncate" title={label}>
        {label}
      </span>
      <Button variant="ghost" size="icon" onClick={onClear} title="Show all leads" aria-label="Show all leads">
        <X size={14} />
      </Button>
    </span>
  );
}

function StatusBadge({ run }: { run: Run }) {
  // Stale is checked before status: a run still claiming "sourcing" that has
  // gone quiet is the one case where the stored status is actively misleading.
  if (run.stale) {
    return (
      <Badge tone="warning">
        <AlertTriangle size={11} /> Stalled
      </Badge>
    );
  }
  switch (run.status) {
    case "sourcing":
      return (
        <Badge tone="neutral">
          <Loader2 size={11} className="animate-spin" /> Sourcing
        </Badge>
      );
    case "enriching":
      return (
        <Badge tone="neutral">
          <Loader2 size={11} className="animate-spin" /> Enriching
        </Badge>
      );
    case "done":
      return (
        <Badge tone="success">
          <Check size={11} strokeWidth={2.5} /> Done
        </Badge>
      );
    case "failed":
      return (
        <Badge tone="danger">
          <X size={11} /> Failed
        </Badge>
      );
    default:
      // 'pending' now means the handoff never reached the agent — a run that
      // started successfully goes straight to 'sourcing'. "Awaiting agent" read
      // as normal progress, which is precisely what it isn't.
      return <Badge tone="neutral">Not started</Badge>;
  }
}

export function RunsPanel({
  runs,
  onFilterRun,
  activeRunId,
}: {
  runs: Run[];
  onFilterRun: (runId: string | null) => void;
  activeRunId: string | null;
}) {
  // An empty state is never inside a card (DESIGN.md → Interaction): the card
  // appears once there are rows to hold.
  if (runs.length === 0) {
    return (
      <section className="mb-6">
        <CardTitle>Searches</CardTitle>
        <Empty
          title="No searches yet"
          hint="Describe an ideal customer above — your agent researches the web and the leads land here."
        />
      </section>
    );
  }

  const live = runs.filter((r) => !r.stale && (r.status === "sourcing" || r.status === "enriching")).length;

  return (
    <Card className="mb-6">
      <Zone className="py-3">
        <CardTitle right={live > 0 ? `${live} in progress` : undefined}>Searches</CardTitle>
      </Zone>
      {runs.map((r) => {
        const active = r.id === activeRunId;
        return (
          <button
            key={r.id}
            onClick={() => onFilterRun(active ? null : r.id)}
            aria-pressed={active}
            className={`flex h-12 w-full items-center gap-3 border-b border-border px-4 text-left last:border-b-0 hover:bg-muted ${
              active ? "bg-muted" : ""
            }`}
            title={active ? "Show all leads" : "Show only this search's leads"}
          >
            {r.source === "sales_navigator" ? (
              <Compass size={16} className="shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <Search size={16} className="shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0 flex-1">
              {/* A search URL is unreadable in a row; name the source and keep
                  the link one hover away. */}
              <span className="block truncate text-sm" title={r.icp_prompt}>
                {r.source === "sales_navigator"
                  ? `Sales Navigator export${r.auto_enrich ? " with emails" : ""}`
                  : r.icp_prompt}
              </span>
              {/* A failure the agent explained is worth surfacing inline — the
                  alternative is a red badge with no way to learn why. */}
              {r.error ? <span className="block truncate text-xs text-destructive">{r.error}</span> : null}
            </span>
            <Chip>
              <span className="data">{r.lead_count}</span> leads
            </Chip>
            {r.credits_spent > 0 ? (
              <Chip>
                <span className="data">{r.credits_spent}</span> credits
              </Chip>
            ) : null}
            <StatusBadge run={r} />
          </button>
        );
      })}
    </Card>
  );
}
