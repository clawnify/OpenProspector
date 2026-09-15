// The review surface for signals. The store can dedupe and date things on its
// own; what it cannot do is decide. So this screen exists to put a live signal
// in front of a person with the evidence attached, and give them exactly two
// answers: source it, or say why not.
//
// Sorting is the opinion here. Accounts carrying more than one live signal come
// first, because one signal is a coincidence, then the freshest. A stale signal
// is never hidden — a source quietly rotting is something you want to see — but
// it cannot be sourced, because a run spends enrichment credits.

import { useCallback, useEffect, useState } from "react";
import { CircleAlert, ExternalLink, Layers, RefreshCw } from "lucide-react";
import { Badge, Button, Chip, Favicon } from "../components/ui";
import { SignalMonitors, MonitorFindings, Pager } from "../components/signal-monitors";
import { api, type Signal } from "../api";

function ageLabel(signal: Signal): string {
  if (signal.age_days === null) return "undated";
  if (signal.age_days === 0) return "today";
  if (signal.age_days === 1) return "1 day ago";
  return `${signal.age_days} days ago`;
}

/** Stack first, then freshest. Undated rows sort last: they are never actionable. */
function order(a: Signal, b: Signal): number {
  if (a.stack !== b.stack) return b.stack - a.stack;
  const aAge = a.age_days ?? Number.MAX_SAFE_INTEGER;
  const bAge = b.age_days ?? Number.MAX_SAFE_INTEGER;
  return aAge - bAge;
}

function SignalRow({ signal, onChanged }: { signal: Signal; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }


  const dismissed = signal.status === "dismissed";
  const queued = signal.status === "queued";

  return (
    <div className={`flex flex-col gap-2 border-b border-border px-3 py-3 last:border-0 ${dismissed ? "opacity-50" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Favicon domain={signal.domain} />
        <span className="text-sm font-medium text-foreground">{signal.company || signal.domain}</span>
        <Chip>{signal.type}</Chip>
        {signal.stack > 1 && (
          <Badge tone="success">
            <Layers size={11} aria-hidden /> {signal.stack} signals
          </Badge>
        )}
        {signal.seen_count > 1 && (
          <Badge tone="warning">
            <RefreshCw size={11} aria-hidden /> seen {signal.seen_count}×
          </Badge>
        )}
        {!signal.live && <Badge tone="danger">stale</Badge>}
        {queued && <Badge tone="neutral">run opened</Badge>}
      </div>

      <p className="text-sm text-foreground">{signal.summary}</p>

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span title={`Event date: ${signal.occurred_at}`}>{ageLabel(signal)}</span>
        {signal.source && <span>via {signal.source}</span>}
        <a
          href={signal.source_url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 underline hover:text-foreground"
        >
          evidence <ExternalLink size={11} aria-hidden />
        </a>
      </div>

      {dismissed && signal.dismiss_reason && (
        <p className="text-xs text-muted-foreground">Dismissed: {signal.dismiss_reason}</p>
      )}

      {error && (
        <p className="inline-flex items-center gap-1.5 text-xs text-destructive">
          <CircleAlert size={12} aria-hidden /> {error}
        </p>
      )}

      {!dismissed && !queued && (
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            disabled={busy || !signal.live}
            title={signal.live ? "Open a sourcing run for this company" : "Outside its freshness window, so it cannot be sourced"}
            onClick={() => void act(() => api.runFromSignal(signal.id))}
          >
            Source this
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setDismissing(true)}>
            Dismiss
          </Button>
        </div>
      )}
      {dismissing && !dismissed && !queued && (
        <form className="space-y-2" onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void act(() => api.dismissSignal(signal.id, reason.trim() || "no reason given"));
        }}>
          <label className="block text-sm">
            Reason for dismissal
            <textarea autoFocus className="input mt-1 w-full py-2" rows={2}
              maxLength={300} value={reason} disabled={busy}
              onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>Confirm dismissal</Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setDismissing(false); setReason(""); }}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}

export function SignalsRoute() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await api.signals({ page });
      setSignals([...res.signals].sort(order));
      setTotal(res.total);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [page]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-8 p-6">
      <SignalMonitors />
      <MonitorFindings />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {signals.length > 0 && <section aria-label="Company findings">
        <h2 className="card-title">Company findings <span className="text-muted-foreground">{total}</span></h2>
        {signals.map(s => <SignalRow key={s.id} signal={s} onChanged={load} />)}
        <Pager page={page} total={total} onPage={setPage} />
      </section>}
    </div>
  );
}
