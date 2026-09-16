import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, RefreshCw } from "lucide-react";
import { api, type AgentServer } from "../api";
import { MONITOR_TEMPLATES, CUSTOM_MONITOR, MonitorInput, type Monitor, type MonitorConfig, type MonitorKind, type Observation } from "../../shared/monitors";
import { Badge, Button, Card, Chip, Empty } from "./ui";

const FREQUENCIES = { once: "On demand", daily: "Daily", weekly: "Weekly" };

export function Pager({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  if (total <= 25) return null;
  return <div className="flex items-center justify-end gap-3 py-3 text-sm">
    <Button disabled={page === 1} onClick={() => onPage(page - 1)}>Previous</Button>
    <span className="data text-muted-foreground">{page} / {Math.ceil(total / 25)}</span>
    <Button disabled={page * 25 >= total} onClick={() => onPage(page + 1)}>Next</Button>
  </div>;
}

export function MonitorForm({ kind, onClose, onSaved }: { kind: MonitorKind; onClose: () => void; onSaved: () => void }) {
  const template = kind === "custom" ? CUSTOM_MONITOR : MONITOR_TEMPLATES.find(t => t.id === kind)!;
  const [name, setName] = useState(kind === "custom" ? "" : template.title as string);
  const [source, setSource] = useState("");
  const [icp, setIcp] = useState("");
  const [serverId, setServerId] = useState("");
  const [frequency, setFrequency] = useState<MonitorConfig["frequency"]>(kind === "post" ? "daily" : "once");
  const [includeExisting, setIncludeExisting] = useState(true);
  const [ends, setEnds] = useState("");
  const [agents, setAgents] = useState<AgentServer[]>([]);
  const [agentPage, setAgentPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [agentsReady, setAgentsReady] = useState(false);
  const [agentRetry, setAgentRetry] = useState(0);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A lost response never rotates either key. A retry cannot mint another
  // native schedule or dispatch the same check twice.
  const request = useRef<{ id: string; checkId: string; config: MonitorConfig } | null>(null);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setAgentsReady(false);
    void api.signalAgents(agentPage).then(r => {
      if (cancelled) return;
      setAgents(r.servers); setHasMore(r.page.has_more); setAgentError(null); setAgentsReady(true);
      setServerId(previous => previous || r.selected || (r.servers.length === 1 && !r.page.has_more && agentPage === 1 ? r.servers[0].id : ""));
    }).catch(e => { if (!cancelled) setAgentError(e.message); });
    return () => { cancelled = true; };
  }, [agentPage, agentRetry]);

  async function submit() {
    setError(null);
    if (!request.current) {
      if (ends && !Number.isFinite(Date.parse(ends))) { setError("Choose a valid end date."); return; }
      const parsed = MonitorInput.safeParse({ name, kind, source, icp, server_id: serverId, frequency, include_existing: includeExisting, ends_at: ends && frequency !== "once" ? new Date(ends).toISOString() : null });
      if (!parsed.success) { setError(parsed.error.issues.map(i => i.message).join(" ")); return; }
      request.current = { id: crypto.randomUUID(), checkId: crypto.randomUUID(), config: parsed.data };
      setSubmitted(true);
    }
    setBusy(true);
    try {
      const r = request.current;
      await api.createMonitor(r.id, r.config);
      // Start the baseline now rather than making a weekly monitor wait a week.
      await api.runMonitor(r.id, r.checkId);
      onSaved();
    } catch (e) { setError((e as Error).message); onSavedPartial(); }
    finally { setBusy(false); }
  }
  function onSavedPartial() {
    // The monitor is durable even if dispatch failed; refresh its sibling list
    // without closing the form or losing the stable retry keys.
    window.dispatchEvent(new Event("monitors-changed"));
  }
  return <Card className="mt-4">
    <form className="space-y-4 p-4" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="flex items-start justify-between gap-3">
        <div><h2 className="card-title">{template.title}</h2><p className="mt-1 text-sm text-muted-foreground">{template.description}</p></div>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
      </div>
      <fieldset disabled={busy || submitted} className="space-y-4 disabled:opacity-60">
        <label className="block text-sm">Name<input className="input mt-1 w-full" value={name} maxLength={100} onChange={e => setName(e.target.value)} required /></label>
        <label className="block text-sm">{template.label}
          <textarea autoFocus className={`input mt-1 w-full py-2 ${kind === "custom" ? "min-h-32" : "min-h-20"}`} rows={kind === "custom" ? 5 : kind === "team" ? 3 : 2} value={source} placeholder={template.placeholder} maxLength={kind === "query" ? 500 : 2500} onChange={e => setSource(e.target.value)} required />
        </label>
        {kind !== "custom" && <label className="block text-sm">Who should we look for?
          <textarea className="input mt-1 min-h-20 w-full py-2" rows={3} value={icp} placeholder="For example: founders of small marketing agencies serving B2B companies" maxLength={1000} onChange={e => setIcp(e.target.value)} required />
        </label>}
        <div className="grid gap-4 md:grid-cols-2">
          <div><label className="block text-sm">Agent
            <select className="input mt-1 w-full" value={serverId} onChange={e => setServerId(e.target.value)} required disabled={!agentsReady}>
              <option value="">Choose an agent…</option>
              {serverId && !agents.some(a => a.id === serverId) && <option value={serverId}>Saved agent ({serverId})</option>}
              {agents.map(a => <option key={a.id} value={a.id}>{a.name || a.id}{a.status !== "ready" ? ` — ${a.status ?? "unavailable"}` : ""}</option>)}
            </select></label>
            {(agentPage > 1 || hasMore) && <div className="mt-2 flex gap-2"><Button disabled={agentPage === 1} onClick={() => setAgentPage(p => p - 1)}>Previous agents</Button><Button disabled={!hasMore} onClick={() => setAgentPage(p => p + 1)}>More agents</Button></div>}
          </div>
          <label className="block text-sm">Check frequency<select className="input mt-1 w-full" value={frequency} onChange={e => setFrequency(e.target.value as MonitorConfig["frequency"])}>
            <option value="once">Run once</option><option value="daily">Every day</option><option value="weekly">Every week</option>
          </select></label>
        </div>
        {frequency !== "once" && <label className="block text-sm">Stop after (optional, your local time)
          <input type="datetime-local" className="input mt-1 w-full" value={ends} onChange={e => setEnds(e.target.value)} />
        </label>}
        <label className="flex items-start gap-2 text-sm"><input className="mt-1 accent-primary" type="checkbox" checked={includeExisting} onChange={e => setIncludeExisting(e.target.checked)} />{kind === "custom" ? "Include existing findings on the first check" : "Include existing engagement on the first check"}</label>
        {!includeExisting && <p className="text-sm text-muted-foreground">{kind === "custom" ? "The first successful check establishes a baseline. Later checks show newly observed findings, not necessarily newly published events." : "The first successful check establishes a baseline. Later checks show newly observed engagement, not necessarily newly posted engagement."}</p>}
      </fieldset>
      <p className="text-xs text-muted-foreground">{kind === "custom" ? "The agent follows your prompt using its available research tools. Findings must identify a person or company, explain the signal, and link to evidence. No outreach or enrichment is started." : "Uses the agent’s logged-in LinkedIn browser. Checks cover up to 10 posts and 100 accessible engagements. No outreach or enrichment is started."}</p>
      {agentError && <p role="alert" className="text-sm text-destructive">Couldn’t load agents: {agentError} <Button variant="ghost" onClick={() => setAgentRetry(n => n + 1)}>Retry agents</Button></p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {submitted && error && <p className="text-xs text-muted-foreground">Setup may already exist. Retry uses the same IDs; check the saved monitor below before starting another.</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" disabled={busy || !agentsReady}>{busy ? "Starting…" : submitted ? "Check / retry setup" : frequency === "once" ? "Run once" : "Start monitoring"}</Button></div>
    </form>
  </Card>;
}

function SavedMonitor({ monitor: m, onChanged }: { monitor: Monitor; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkKey = useRef<string | null>(null);
  const running = m.last_check?.status === "sourcing";
  const expired = Boolean(m.ends_at && Date.parse(m.ends_at) <= Date.now());
  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); onChanged(); }
  }
  const { id, active, schedule_id, schedule_error, created_at, last_check, ...cfg } = m;
  return <article className="border-b border-border py-4 last:border-b-0">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">{m.name}</h3><Chip>{FREQUENCIES[m.frequency]}</Chip><Badge tone={running ? "warning" : "neutral"}>{expired ? "Ended" : !m.active ? "Paused" : running ? "Checking" : "Ready"}</Badge></div>
    <p className="mt-1 break-words text-xs text-muted-foreground">{m.source}</p>
    {m.icp && <p className="mt-1 text-sm text-muted-foreground">{m.icp}</p>}
    {m.last_check && <p className="mt-2 text-xs text-muted-foreground">Last check: {m.last_check.status} · {m.last_check.updated_at} UTC</p>}
    {m.last_check?.coverage && <p className="mt-1 text-xs text-muted-foreground">Coverage: {m.last_check.coverage}</p>}
    {m.ends_at && <p className="mt-1 text-xs text-muted-foreground">Ends: {new Date(m.ends_at).toLocaleString()}</p>}
    {(m.schedule_error || m.last_check?.error || error) && <p role="alert" className="mt-2 text-sm text-destructive">{error || m.schedule_error || m.last_check?.error}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <Button disabled={busy || running || !m.active || expired} onClick={() => void act(async () => {
        const key = checkKey.current ?? crypto.randomUUID(); checkKey.current = key;
        await api.runMonitor(m.id, key); checkKey.current = null;
      })}>Run now</Button>
      <Button variant="ghost" disabled={busy || (expired && !m.active)} onClick={() => void act(() => api.toggleMonitor(m.id, !m.active))}>{m.active ? "Pause" : "Resume"}</Button>
      {m.schedule_error && !m.schedule_id && <Button disabled={busy} onClick={() => void act(() => api.createMonitor(id, cfg))}>Retry schedule setup</Button>}
      {m.schedule_error && !m.active && m.schedule_id && <Button disabled={busy} onClick={() => void act(() => api.toggleMonitor(m.id, false))}>Retry schedule pause</Button>}
      {running && <Button variant="ghost" disabled={busy} onClick={() => void act(() => api.interruptCheck(m.last_check!.id))}>Interrupt check</Button>}
    </div>
    {running && <p className="mt-1 text-xs text-muted-foreground">Interrupt closes this check to further results; it does not terminate the agent session.</p>}
  </article>;
}

export function SignalMonitors() {
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<MonitorKind | null>(null);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const r = await api.monitors(page); setMonitors(r.monitors); setTotal(r.total); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [page]);
  useEffect(() => {
    void load(); const timer = window.setInterval(() => void load(), 15000);
    const changed = () => void load(); window.addEventListener("monitors-changed", changed);
    return () => { clearInterval(timer); window.removeEventListener("monitors-changed", changed); };
  }, [load]);
  return <section aria-label="Signal monitors" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="card-title">Your monitors <span className="text-muted-foreground">{total}</span></h2>
      {!creating && <Button variant="primary" onClick={() => setCreating(true)}><Plus size={14} />New signal</Button>}
    </div>
    {creating && !kind && <div className="space-y-4" aria-label="Choose a signal template">
      <div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-medium">Choose a starting point</h3><p className="mt-1 text-sm text-muted-foreground">Use a LinkedIn template or start with your own brief.</p></div><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button></div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {MONITOR_TEMPLATES.map(t => <button key={t.id} type="button" onClick={() => setKind(t.id)} className="card min-w-0 p-4 text-left transition-colors hover:bg-muted">
          <img src={import.meta.env.VITE_LINKEDIN_LOGO_URL} alt="LinkedIn" width={22} height={22} className="mb-3" /><span className="block text-sm font-medium">{t.title}</span><span className="mt-1 block text-xs text-muted-foreground">{t.description}</span>
        </button>)}
      </div>
      <Button onClick={() => setKind("custom")}><Plus size={14} />Start from scratch</Button>
    </div>}
    {creating && kind && <MonitorForm key={kind} kind={kind} onClose={() => { setKind(null); setCreating(false); }} onSaved={() => { setKind(null); setCreating(false); void load(); }} />}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {monitors.length > 0 && <section aria-label="Saved monitors"><div className="flex justify-end"><Button variant="ghost" onClick={() => void load()}><RefreshCw size={14} />Refresh</Button></div>
      {monitors.map(m => <SavedMonitor key={m.id} monitor={m} onChanged={() => void load()} />)}
      <Pager page={page} total={total} onPage={setPage} />
    </section>}
  </section>;
}

export function Finding({ item, onChanged }: { item: Observation; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <article className="space-y-2 border-b border-border py-4 last:border-b-0">
    {"kind" in item ? <>
      <div className="flex flex-wrap items-center gap-2"><a className="text-sm font-medium underline" href={item.subject.type === "company" ? `https://${item.subject.domain}` : item.subject.profile_url} target="_blank" rel="noreferrer">{item.subject.name}</a><Badge>{item.subject.type === "company" ? "Company" : "Person"}</Badge></div>
      <p className="text-sm">{item.summary}</p>
      <p className="text-sm"><span className="font-medium">Signal reason: </span>{item.reason}</p>
    </> : <>
    <div className="flex flex-wrap items-center gap-2"><a className="text-sm font-medium underline" href={item.profile_url} target="_blank" rel="noreferrer">{item.person_name}</a>{item.company && <Chip>{item.company}</Chip>}<Badge>{item.engagement}</Badge></div>
    {item.quote && <blockquote className="text-sm">“{item.quote}”</blockquote>}
    <p className="text-sm"><span className="font-medium">ICP fit: </span>{item.why_fit}</p>
    <p className="text-sm"><span className="font-medium">Outreach context: </span>{item.outreach_context}</p>
    </>}
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><a className="underline" href={item.source_url} target="_blank" rel="noreferrer">View evidence</a><span>{item.occurred_at ? `Event: ${item.occurred_at}` : "Event date unknown"}</span><span>Observed: {item.observed_at} UTC</span></div>
    {!("kind" in item && item.subject.type === "company") && (item.lead_id ? <Link className="text-sm underline" to="/">Added to people</Link> : <Button disabled={busy} onClick={() => { setBusy(true); setError(null); void api.promoteObservation(item.id).then(onChanged).catch(e => setError(e.message)).finally(() => setBusy(false)); }}><Plus size={14} />Add to people</Button>)}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </article>;
}

export function MonitorFindings() {
  const [items, setItems] = useState<Observation[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const r = await api.observations(page); setItems(r.observations); setTotal(r.total); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [page]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 15000); return () => clearInterval(timer); }, [load]);
  return <section aria-label="Signal findings"><h2 className="card-title">Signal findings <span className="text-muted-foreground">{total}</span></h2>
    {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : items.length === 0 ? <Empty title="Your next conversation starts here" hint="Start a monitor above. Person and company signals appear here with evidence and a reason; baseline-only findings stay out of the feed." /> : items.map(item => <Finding key={item.id} item={item} onChanged={() => void load()} />)}
    <Pager page={page} total={total} onPage={setPage} />
  </section>;
}
