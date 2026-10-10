import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Pencil, Plus, RefreshCw, Users } from "lucide-react";
import { api, type AgentServer } from "../api";
import { MONITOR_TEMPLATES, CUSTOM_MONITOR, MonitorEdit, MonitorInput, findsContacts, type CompanySearch, type Monitor, type MonitorConfig, type MonitorEditInput, type MonitorKind, type Observation } from "../../shared/monitors";
import { Badge, Button, Card, Chip, Dialog, Empty, Picker } from "./ui";

const FREQUENCIES = { once: "On demand", daily: "Daily", weekly: "Weekly" };
const FREQUENCY_OPTIONS = [{ value: "once", label: "Run once" }, { value: "daily", label: "Every day" }, { value: "weekly", label: "Every week" }];
const DEFAULT_MAX = 25;

/** The org's agents, a page at a time, plus the one Settings picked. */
function useSignalAgents() {
  const [agents, setAgents] = useState<AgentServer[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [ready, setReady] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void api.signalAgents(page).then(r => {
      if (cancelled) return;
      setAgents(r.servers); setHasMore(r.page.has_more); setError(null); setReady(true);
      // The only agent, when there is exactly one, counts as picked.
      setSelected(r.selected || (r.servers.length === 1 && !r.page.has_more && page === 1 ? r.servers[0].id : null));
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [page, retry]);
  return { agents, page, setPage, hasMore, ready, error, retry: () => setRetry(n => n + 1), selected };
}

function AgentField({ value, onChange, list }: { value: string; onChange: (id: string) => void; list: ReturnType<typeof useSignalAgents> }) {
  const options = list.agents.map(a => ({ value: a.id, label: a.name || a.id, hint: a.status !== "ready" ? a.status ?? "unavailable" : undefined }));
  if (value && !options.some(o => o.value === value)) options.unshift({ value, label: "Saved agent", hint: undefined });
  return <div className="block text-sm">Agent
    <Picker label="Agent" value={value} options={options} onChange={onChange} placeholder="Choose an agent" disabled={!list.ready} className="mt-1 w-full" />
    {(list.page > 1 || list.hasMore) && <div className="mt-2 flex gap-2"><Button disabled={list.page === 1} onClick={() => list.setPage(p => p - 1)}>Previous agents</Button><Button disabled={!list.hasMore} onClick={() => list.setPage(p => p + 1)}>More agents</Button></div>}
    {list.error && <p role="alert" className="mt-1 text-sm text-destructive">Couldn’t load agents: {list.error} <Button variant="ghost" onClick={list.retry}>Retry agents</Button></p>}
  </div>;
}

function MaxField({ kind, finds, value, onChange }: { kind: MonitorKind; finds?: MonitorConfig["finds"]; value: string; onChange: (value: string) => void }) {
  const what = kind !== "custom" || finds === "people" ? "new people" : finds === "companies" ? "new companies" : "new findings";
  return <label className="block text-sm">At most
    <span className="mt-1 flex items-center gap-2">
      <input type="number" inputMode="numeric" min={1} max={100} className="input w-20 data" value={value} onChange={e => onChange(e.target.value)} required />
      <span className="text-muted-foreground">{what} per check</span>
    </span>
  </label>;
}

/** What a custom signal records. One kind, so its options and its findings match. */
const FINDS = {
  companies: { label: "Which companies should it find?", placeholder: "For example: field service companies with their own vans that work in Amsterdam, and why they would need us." },
  people: { label: "Which people should it find?", placeholder: "For example: creative directors at Amsterdam agencies who started the job in the last 90 days." },
} as const;
type Finds = keyof typeof FINDS;

function FindsField({ value, onChange }: { value: Finds; onChange: (value: Finds) => void }) {
  return <div className="text-sm">What should it find?
    <div role="group" aria-label="What should it find?" className="mt-1 flex w-fit rounded-sm bg-muted p-0.5">
      {([["companies", "Companies"], ["people", "People"]] as const).map(([v, label]) =>
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
          className={`h-7 whitespace-nowrap rounded-[3px] px-2.5 text-xs font-medium ${value === v ? "bg-background text-foreground shadow-raised" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>)}
    </div>
  </div>;
}

/** Signals that find companies: whether each new company gets a search for who to contact there. */
function ContactsField({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex items-start gap-2 text-sm">
    <input className="mt-1 accent-primary" type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
    <span>Find who to contact at each company
      <span className="mt-0.5 block text-xs text-muted-foreground">{checked ? "Each new company it finds gets a search for its people." : "Its companies wait on Signals: press Find people on the ones you want."}</span>
    </span>
  </label>;
}

/** Signals that find companies: who a company search looks for there, in words the agent reads. */
function WhoField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="block text-sm">Who to contact (optional)
    <input className="input mt-1 w-full" value={value} maxLength={300} placeholder="For example: the Creative Director, or the owner's son who works there" onChange={e => onChange(e.target.value)} />
    <span className="mt-1 block text-xs text-muted-foreground">In plain words: a role, a situation such as new in the job, or a relation. Your agent reads the company's site and registry, and adds nobody rather than guess. Left empty: the owner, or at a larger company up to 3 people who decide.</span>
  </label>;
}

/** An ISO time as a datetime-local value, in the viewer's time zone. */
function localInput(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

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
  const [max, setMax] = useState(String(DEFAULT_MAX));
  const [who, setWho] = useState("");
  const [finds, setFinds] = useState<Finds>("companies");
  const [contacts, setContacts] = useState(true);
  const agentList = useSignalAgents();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A lost response never rotates either key. A retry cannot mint another
  // native schedule or dispatch the same check twice.
  const request = useRef<{ id: string; checkId: string; config: MonitorConfig } | null>(null);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => { if (agentList.selected) setServerId(previous => previous || agentList.selected!); }, [agentList.selected]);

  async function submit() {
    setError(null);
    if (!request.current) {
      if (ends && !Number.isFinite(Date.parse(ends))) { setError("Choose a valid end date."); return; }
      const companies = kind === "custom" && finds === "companies";
      const parsed = MonitorInput.safeParse({ name, kind, source, icp, server_id: serverId, frequency, include_existing: includeExisting, ends_at: ends && frequency !== "once" ? new Date(ends).toISOString() : null, max_per_check: Number(max), who_to_contact: companies ? who : "",
        ...(kind === "custom" ? { finds, ...(companies ? { find_contacts: contacts } : {}) } : {}) });
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
        {kind === "custom" && <FindsField value={finds} onChange={setFinds} />}
        <label className="block text-sm">{kind === "custom" ? FINDS[finds].label : template.label}
          <textarea autoFocus className={`input mt-1 w-full py-2 ${kind === "custom" ? "min-h-32" : "min-h-20"}`} rows={kind === "custom" ? 5 : kind === "team" ? 3 : 2} value={source} placeholder={kind === "custom" ? FINDS[finds].placeholder : template.placeholder} maxLength={kind === "query" ? 500 : 2500} onChange={e => setSource(e.target.value)} required />
        </label>
        {kind !== "custom" && <label className="block text-sm">Who should we look for?
          <textarea className="input mt-1 min-h-20 w-full py-2" rows={3} value={icp} placeholder="For example: founders of small marketing agencies serving B2B companies" maxLength={1000} onChange={e => setIcp(e.target.value)} required />
        </label>}
        {kind === "custom" && finds === "companies" && <>
          <ContactsField checked={contacts} onChange={setContacts} />
          <WhoField value={who} onChange={setWho} />
        </>}
        <div className="grid gap-4 md:grid-cols-2">
          <AgentField value={serverId} onChange={setServerId} list={agentList} />
          <div className="block text-sm">Check frequency
            <Picker label="Check frequency" value={frequency} options={FREQUENCY_OPTIONS} onChange={v => setFrequency(v as MonitorConfig["frequency"])} className="mt-1 w-full" />
          </div>
        </div>
        {frequency !== "once" && <label className="block text-sm">Stop after (optional, your local time)
          <input type="datetime-local" className="input mt-1 w-full" value={ends} onChange={e => setEnds(e.target.value)} />
        </label>}
        <MaxField kind={kind} finds={kind === "custom" ? finds : undefined} value={max} onChange={setMax} />
        <label className="flex items-start gap-2 text-sm"><input className="mt-1 accent-primary" type="checkbox" checked={includeExisting} onChange={e => setIncludeExisting(e.target.checked)} />{kind === "custom" ? "Include existing findings on the first check" : "Include existing engagement on the first check"}</label>
        {!includeExisting && <p className="text-sm text-muted-foreground">{kind === "custom" ? "The first successful check establishes a baseline. Later checks show newly observed findings, not necessarily newly published events." : "The first successful check establishes a baseline. Later checks show newly observed engagement, not necessarily newly posted engagement."}</p>}
      </fieldset>
      <p className="text-xs text-muted-foreground">{kind === "custom" ? "The agent follows your prompt using its available research tools. Findings must identify a person or company, explain the signal, and link to evidence. No outreach or enrichment is started." : "Uses the agent’s logged-in LinkedIn browser. Checks cover up to 10 posts and 100 accessible engagements. No outreach or enrichment is started."}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {submitted && error && <p className="text-xs text-muted-foreground">Setup may already exist. Retry uses the same IDs; check the saved monitor below before starting another.</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" disabled={busy || !agentList.ready}>{busy ? "Starting…" : submitted ? "Check / retry setup" : frequency === "once" ? "Run once" : "Start monitoring"}</Button></div>
    </form>
  </Card>;
}

/**
 * Change a saved signal. What a LinkedIn signal watches stays fixed; a custom
 * signal's prompt can change. One request id per set of settings, so a retry
 * after a lost response replays the same schedule move.
 */
export function EditMonitor({ monitor: m, open, onOpenChange, onSaved }: { monitor: Monitor; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const custom = m.kind === "custom";
  const [name, setName] = useState(m.name);
  const [source, setSource] = useState(m.source);
  const [icp, setIcp] = useState(m.icp);
  const [serverId, setServerId] = useState(m.server_id);
  const [frequency, setFrequency] = useState(m.frequency);
  const [ends, setEnds] = useState(localInput(m.ends_at));
  const [max, setMax] = useState(String(m.max_per_check));
  const [who, setWho] = useState(m.who_to_contact);
  // What it finds stays fixed; a signal saved before the choice may find companies.
  const companies = custom && m.finds !== "people";
  const [contacts, setContacts] = useState(findsContacts(m));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ id: string; body: string } | null>(null);
  const agentList = useSignalAgents();
  async function submit() {
    setError(null);
    if (ends && frequency !== "once" && !Number.isFinite(Date.parse(ends))) { setError("Choose a valid end date."); return; }
    const parsed = MonitorEdit.safeParse({ name, icp, server_id: serverId, frequency, max_per_check: Number(max), who_to_contact: who,
      ends_at: ends && frequency !== "once" ? new Date(ends).toISOString() : null, ...(custom ? { source } : {}), ...(companies ? { find_contacts: contacts } : {}) });
    if (!parsed.success) { setError(parsed.error.issues.map(i => i.message).join(" ")); return; }
    const body = JSON.stringify(parsed.data);
    if (attempt.current?.body !== body) attempt.current = { id: crypto.randomUUID(), body };
    setBusy(true);
    try { await api.editMonitor(m.id, attempt.current.id, parsed.data); attempt.current = null; onSaved(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange} title="Edit signal" submitLabel={busy ? "Saving…" : "Save"} submitting={busy} onSubmit={() => void submit()}>
    <label className="block text-sm">Name<input className="input mt-1 w-full" value={name} maxLength={100} onChange={e => setName(e.target.value)} required /></label>
    {custom ? <>
      <label className="block text-sm">{m.finds ? FINDS[m.finds].label : "Prompt"}
        <textarea className="input mt-1 min-h-32 w-full py-2" rows={5} value={source} maxLength={2500} onChange={e => setSource(e.target.value)} required />
      </label>
      {companies && <>
        <ContactsField checked={contacts} onChange={setContacts} />
        <WhoField value={who} onChange={setWho} />
      </>}
    </> : <>
      <label className="block text-sm">Who should we look for?
        <textarea className="input mt-1 min-h-20 w-full py-2" rows={3} value={icp} maxLength={1000} onChange={e => setIcp(e.target.value)} required />
      </label>
      <div className="text-sm">Watching<p className="mt-1 break-words text-xs text-muted-foreground">{m.source}</p>
        <p className="mt-1 text-xs text-muted-foreground">This stays fixed, because the findings so far belong to it. Create another signal to watch something else.</p></div>
    </>}
    <AgentField value={serverId} onChange={setServerId} list={agentList} />
    <div className="block text-sm">Check frequency
      <Picker label="Check frequency" value={frequency} options={FREQUENCY_OPTIONS} onChange={v => setFrequency(v as MonitorConfig["frequency"])} className="mt-1 w-full" />
    </div>
    {frequency !== "once" && <label className="block text-sm">Stop after (optional, your local time)
      <input type="datetime-local" className="input mt-1 w-full" value={ends} onChange={e => setEnds(e.target.value)} />
    </label>}
    <MaxField kind={m.kind} finds={m.finds} value={max} onChange={setMax} />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </Dialog>;
}

function SavedMonitor({ monitor: m, onChanged }: { monitor: Monitor; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
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
  const { id, active, schedule_id, schedule_error, created_at, last_check, lists_fed, ...cfg } = m;
  return <article className="border-b border-border py-4 last:border-b-0">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">{m.name}</h3><Chip>{FREQUENCIES[m.frequency]}</Chip><Chip>Up to {m.max_per_check} a check</Chip>{m.finds && <Chip>Finds {m.finds}</Chip>}{findsContacts(m) && <Chip>Finds who to contact</Chip>}<Badge tone={running ? "warning" : "neutral"}>{expired ? "Ended" : !m.active ? "Paused" : running ? "Checking" : "Ready"}</Badge></div>
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
      <Button variant="ghost" disabled={busy} onClick={() => setEditing(true)}><Pencil size={14} />Edit</Button>
      {running && <Button variant="ghost" disabled={busy} onClick={() => void act(() => api.interruptCheck(m.last_check!.id))}>Interrupt check</Button>}
    </div>
    {/* Mounted only while open, so it starts from the saved settings each time. */}
    {editing && <EditMonitor monitor={m} open onOpenChange={setEditing} onSaved={() => { setEditing(false); onChanged(); }} />}
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

/**
 * Where the search for the person to contact at a finding's company stands.
 * One search per company, so every finding of that company shows the same one.
 */
function CompanyPeople({ item, search, onChanged }: { item: Observation; search: CompanySearch | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    void fn().then(onChanged).catch(e => setError((e as Error).message)).finally(() => setBusy(false));
  };
  const retry = <Button disabled={busy} onClick={() => act(() => api.dispatchRun(search!.id))}>Retry</Button>;
  let state: ReactNode;
  if (!search) state = <Button disabled={busy} onClick={() => act(() => api.findPeople(item.id))}><Users size={14} />Find people</Button>;
  else if (search.status === "pending") state = search.error
    ? <><span className="text-destructive">Couldn’t hand it to your agent: {search.error}</span>{retry}</>
    : <span className="text-muted-foreground">Waiting for your agent</span>;
  else if (["sourcing", "enriching"].includes(search.status)) state = search.stale
    ? <><span className="text-muted-foreground">Your agent stopped reporting on this search.</span>{retry}</>
    : <span className="text-muted-foreground">Finding who to contact…</span>;
  else if (search.status === "done") state = search.lead_count > 0
    ? <Link className="underline" to={`/?run=${search.id}`}>{search.lead_count} {search.lead_count === 1 ? "person" : "people"} to contact</Link>
    : <span className="text-muted-foreground">No one found to contact</span>;
  else state = <><span className="text-destructive">Search failed{search.error ? `: ${search.error}` : ""}</span>{retry}</>;
  return <div className="flex flex-wrap items-center gap-3 text-sm">
    {state}
    {error && <p role="alert" className="w-full text-sm text-destructive">{error}</p>}
  </div>;
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
    {"kind" in item && item.subject.type === "company" && <CompanyPeople item={item} search={item.search} onChanged={onChanged} />}
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
