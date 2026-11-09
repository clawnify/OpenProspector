// Signals: searches that run on a repeat and record what they find with its
// evidence. They are created inside a list (MonitorForm), shown there as one
// compact row each (SignalRow), and the ones that feed no list wait on
// To review with their findings (UnlistedSignals, MonitorFindings).

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Activity, ChevronDown, ChevronRight, Pause, Pencil, Play, Plus, Users } from "lucide-react";
import { api, type AgentServer } from "../api";
import { MONITOR_TEMPLATES, CUSTOM_MONITOR, MonitorEdit, MonitorInput, findsContacts, type CompanySearch, type Monitor, type MonitorConfig, type MonitorEditInput, type MonitorKind, type Observation } from "../../shared/monitors";
import { Badge, Button, Card, Chip, Dialog, Empty, Picker, Tooltip } from "./ui";
import { ago } from "../time";

/** How often a search or signal runs, in words. A search's "off" and a signal's "once" both run once. */
export const REPEAT_LABELS: Record<string, string> = {
  once: "Runs once", off: "Runs once", hourly: "Every hour", daily: "Every day", weekly: "Every week", biweekly: "Every 2 weeks",
};
const FREQUENCY_OPTIONS = [
  { value: "once", label: "Run once" }, { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" }, { value: "biweekly", label: "Every 2 weeks" },
];
/** New findings one run records. Ten is what the live company signals settled on. */
const DEFAULT_MAX = 10;

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

function RepeatField({ value, onChange }: { value: string; onChange: (value: MonitorConfig["frequency"]) => void }) {
  return <div className="block text-sm">Repeat
    <Picker label="Repeat" value={value} options={FREQUENCY_OPTIONS} onChange={v => onChange(v as MonitorConfig["frequency"])} className="mt-1 w-full" />
  </div>;
}

function MaxField({ kind, finds, value, onChange }: { kind: MonitorKind; finds?: MonitorConfig["finds"]; value: string; onChange: (value: string) => void }) {
  const what = kind !== "custom" || finds === "people" ? "new people" : finds === "companies" ? "new companies" : "new findings";
  return <label className="block text-sm">At most
    <span className="mt-1 flex items-center gap-2">
      <input type="number" inputMode="numeric" min={1} max={100} className="input w-20 data" value={value} onChange={e => onChange(e.target.value)} required />
      <span className="text-muted-foreground">{what} a run</span>
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
  return <div role="group" aria-label="What should it find?" className="flex w-fit rounded-sm bg-muted p-0.5">
    {([["companies", "Companies"], ["people", "People"]] as const).map(([v, label]) =>
      <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
        className={`h-7 whitespace-nowrap rounded-[3px] px-2.5 text-xs font-medium ${value === v ? "bg-background text-foreground shadow-raised" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>)}
  </div>;
}

/** Signals that find companies: whether each new company gets a search for who to contact there. */
function ContactsField({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex items-start gap-2 text-sm">
    <input className="mt-1 accent-primary" type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
    <span>Find who to contact at each company
      <span className="mt-0.5 block text-xs text-muted-foreground">{checked ? "Each new company it finds gets a search for its people, and they join the list." : "Its companies wait on To review: press Find people on the ones you want."}</span>
    </span>
  </label>;
}

/** Signals that find companies: who a company search looks for there, in words the agent reads. */
function WhoField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="block text-sm">Who to contact (optional)
    <input className="input mt-1 w-full" value={value} maxLength={300} placeholder="For example: the Creative Director, or the operations manager" onChange={e => onChange(e.target.value)} />
    <span className="mt-1 block text-xs text-muted-foreground">In plain words: a role, or a situation such as new in the job. Your agent reads the company's site and registry, and adds nobody rather than guess. Left empty: the owner, or at a larger company up to 3 people who decide.</span>
  </label>;
}

/**
 * A company signal's contact settings: the switch, and who to look for while it
 * is on. Off hides the field but keeps what it says, which Find people still uses.
 */
export function ContactFields({ contacts, onContacts, who, onWho }: { contacts: boolean; onContacts: (on: boolean) => void; who: string; onWho: (who: string) => void }) {
  return <>
    <ContactsField checked={contacts} onChange={onContacts} />
    {contacts && <WhoField value={who} onChange={onWho} />}
  </>;
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

/**
 * What adding a signal to a list did: people it already found who joined, and
 * companies whose people are being looked for, or, on a signal set not to
 * look, are waiting.
 */
export function addedMessage(added: number, searching: number, contacts: boolean): string {
  const people = added ? ` ${added} ${added === 1 ? "lead" : "leads"} it already found joined this list.` : "";
  const companies = searching ? ` Finding who to contact at ${searching} ${searching === 1 ? "company" : "companies"} it found.` : "";
  const waiting = contacts ? "" : " Its companies wait on To review: press Find people on the ones you want, and their people join this list.";
  return `Added.${people}${companies}${waiting}`;
}

/**
 * A new signal, made inside a list: the list's first search reads as one
 * question (who should this list find, companies or people), and the rest
 * waits under More settings. Saved, then added to the list, then started, so
 * what its first run finds already joins the list.
 */
export function MonitorForm({ kind, listId, listName, onClose, onSaved }: { kind: MonitorKind; listId: string; listName?: string; onClose: () => void; onSaved: (message: string) => void }) {
  const custom = kind === "custom";
  const template = custom ? CUSTOM_MONITOR : MONITOR_TEMPLATES.find(t => t.id === kind)!;
  const [name, setName] = useState(custom ? (listName ?? "") : template.title as string);
  const [source, setSource] = useState("");
  const [icp, setIcp] = useState("");
  const [serverId, setServerId] = useState("");
  const [frequency, setFrequency] = useState<MonitorConfig["frequency"]>("weekly");
  const [includeExisting, setIncludeExisting] = useState(true);
  const [ends, setEnds] = useState("");
  const [max, setMax] = useState(String(DEFAULT_MAX));
  const [who, setWho] = useState("");
  const [finds, setFinds] = useState<Finds>("companies");
  const [contacts, setContacts] = useState(true);
  const [more, setMore] = useState(false);
  const agentList = useSignalAgents();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A lost response never rotates either key. A retry cannot mint another
  // native schedule or dispatch the same check twice.
  const request = useRef<{ id: string; checkId: string; config: MonitorConfig; message?: string } | null>(null);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => { if (agentList.selected) setServerId(previous => previous || agentList.selected!); }, [agentList.selected]);
  // The agent is chosen for you when Settings names one or there is only one.
  // Otherwise, or when the agents can't be read, the field is in view.
  const pickAgent = Boolean(agentList.error) || (agentList.ready && !agentList.selected);

  async function submit() {
    setError(null);
    if (!request.current) {
      if (ends && !Number.isFinite(Date.parse(ends))) { setError("Choose a valid end date."); return; }
      const companies = custom && finds === "companies";
      const parsed = MonitorInput.safeParse({ name: name.trim() || source.trim().split("\n")[0].slice(0, 100), kind, source, icp, server_id: serverId, frequency, include_existing: includeExisting, ends_at: ends && frequency !== "once" ? new Date(ends).toISOString() : null, max_per_check: Number(max), who_to_contact: companies ? who : "",
        ...(custom ? { finds, ...(companies ? { find_contacts: contacts } : {}) } : {}) });
      if (!parsed.success) { setError(parsed.error.issues.map(i => (i.path[0] === "server_id" ? "Choose the agent that runs it." : i.message)).join(" ")); return; }
      request.current = { id: crypto.randomUUID(), checkId: crypto.randomUUID(), config: parsed.data };
      setSubmitted(true);
    }
    setBusy(true);
    try {
      const r = request.current;
      await api.createMonitor(r.id, r.config);
      if (r.message === undefined) {
        const added = await api.addListSource(listId, "signal", r.id);
        r.message = addedMessage(added.added, added.searching, added.contacts);
      }
      // Start the first run now rather than making a weekly signal wait a week.
      await api.runMonitor(r.id, r.checkId);
      onSaved(`${r.message} Its first run has started; new leads join as they are found.`);
    } catch (e) { setError((e as Error).message); window.dispatchEvent(new Event("monitors-changed")); }
    finally { setBusy(false); }
  }
  const prompt = custom ? FINDS[finds] : { label: template.label, placeholder: template.placeholder };
  return <Card className="mt-4">
    <form className="space-y-4 p-4" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="card-title">{custom ? "Who should this list find?" : template.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{custom ? "Describe them in your own words. Your agent researches the web on the repeat you choose, and each find comes with its evidence." : template.description}</p>
        </div>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
      </div>
      <fieldset disabled={busy || submitted} className="space-y-4 disabled:opacity-60">
        {custom && <FindsField value={finds} onChange={setFinds} />}
        <label className="block text-sm"><span className={custom ? "sr-only" : ""}>{prompt.label}</span>
          <textarea autoFocus className={`input w-full py-2 ${custom ? "min-h-28" : "mt-1 min-h-20"}`} rows={custom ? 4 : kind === "team" ? 3 : 2} value={source} placeholder={prompt.placeholder} maxLength={kind === "query" ? 500 : 2500} onChange={e => setSource(e.target.value)} required />
        </label>
        {!custom && <label className="block text-sm">Who should we look for?
          <textarea className="input mt-1 min-h-20 w-full py-2" rows={3} value={icp} placeholder="For example: founders of small marketing agencies serving B2B companies" maxLength={1000} onChange={e => setIcp(e.target.value)} required />
        </label>}
        {custom && finds === "companies" && <ContactFields contacts={contacts} onContacts={setContacts} who={who} onWho={setWho} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <RepeatField value={frequency} onChange={setFrequency} />
          <MaxField kind={kind} finds={custom ? finds : undefined} value={max} onChange={setMax} />
        </div>
        {pickAgent && <AgentField value={serverId} onChange={setServerId} list={agentList} />}
        <button type="button" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" aria-expanded={more} onClick={() => setMore(v => !v)}>
          {more ? <ChevronDown size={14} /> : <ChevronRight size={14} />}More settings
        </button>
        {more && <div className="space-y-4">
          <label className="block text-sm">Name<input className="input mt-1 w-full" value={name} maxLength={100} placeholder="Named after what it finds when left empty" onChange={e => setName(e.target.value)} /></label>
          {!pickAgent && <AgentField value={serverId} onChange={setServerId} list={agentList} />}
          {frequency !== "once" && <label className="block text-sm">Stop after (optional, your local time)
            <input type="datetime-local" className="input mt-1 w-full" value={ends} onChange={e => setEnds(e.target.value)} />
          </label>}
          <label className="flex items-start gap-2 text-sm"><input className="mt-1 accent-primary" type="checkbox" checked={includeExisting} onChange={e => setIncludeExisting(e.target.checked)} />{custom ? "Include what already exists on the first run" : "Include existing engagement on the first run"}</label>
          {!includeExisting && <p className="text-sm text-muted-foreground">The first run only sets a starting point. Later runs show what is new since, not necessarily newly published.</p>}
        </div>}
      </fieldset>
      <p className="text-xs text-muted-foreground">{custom ? "What it finds joins this list. Emails are looked up only up to the list's daily number." : "Uses the agent’s logged-in LinkedIn browser. A run covers up to 10 posts and 100 accessible engagements. The people it finds join this list."}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {submitted && error && <p className="text-xs text-muted-foreground">It may already be saved. Retry uses the same IDs, so it is never made twice.</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" disabled={busy || !agentList.ready}>{busy ? "Starting…" : submitted ? "Retry" : "Add to list"}</Button></div>
    </form>
  </Card>;
}

/**
 * Change a saved signal. What a LinkedIn signal watches stays fixed; a custom
 * signal's prompt can change. One request id per set of settings, so a retry
 * after a lost response replays the same schedule move. The change applies in
 * every list it feeds.
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
  return <Dialog open={open} onOpenChange={onOpenChange} title="Edit search" description={m.lists_fed > 1 ? `It feeds ${m.lists_fed} lists: the change applies to all of them.` : undefined} submitLabel={busy ? "Saving…" : "Save"} submitting={busy} onSubmit={() => void submit()}>
    <label className="block text-sm">Name<input className="input mt-1 w-full" value={name} maxLength={100} onChange={e => setName(e.target.value)} required /></label>
    {custom ? <>
      <label className="block text-sm">{m.finds ? FINDS[m.finds].label : "Prompt"}
        <textarea className="input mt-1 min-h-32 w-full py-2" rows={5} value={source} maxLength={2500} onChange={e => setSource(e.target.value)} required />
      </label>
      {companies && <ContactFields contacts={contacts} onContacts={setContacts} who={who} onWho={setWho} />}
    </> : <>
      <label className="block text-sm">Who should we look for?
        <textarea className="input mt-1 min-h-20 w-full py-2" rows={3} value={icp} maxLength={1000} onChange={e => setIcp(e.target.value)} required />
      </label>
      <div className="text-sm">Watching<p className="mt-1 break-words text-xs text-muted-foreground">{m.source}</p>
        <p className="mt-1 text-xs text-muted-foreground">This stays fixed, because what it found so far belongs to it. Add another search to watch something else.</p></div>
    </>}
    <AgentField value={serverId} onChange={setServerId} list={agentList} />
    <RepeatField value={frequency} onChange={setFrequency} />
    {frequency !== "once" && <label className="block text-sm">Stop after (optional, your local time)
      <input type="datetime-local" className="input mt-1 w-full" value={ends} onChange={e => setEnds(e.target.value)} />
    </label>}
    <MaxField kind={m.kind} finds={m.finds} value={max} onChange={setMax} />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </Dialog>;
}

/** What a signal finds and how often, in one line. */
export function signalSummary(m: Monitor): string {
  const what = m.kind === "custom"
    ? m.finds === "people" ? "Finds people" : m.finds === "companies" ? "Finds companies" : "Finds companies or people"
    : `LinkedIn: ${MONITOR_TEMPLATES.find(t => t.id === m.kind)?.title ?? "engagement"}`;
  return [what, REPEAT_LABELS[m.frequency] ?? m.frequency, `up to ${m.max_per_check} a run`, findsContacts(m) ? "finds who to contact" : null]
    .filter(Boolean).join(" · ");
}

/** Where a signal stands, in one line, and how loud to say it. */
export function signalStatus(m: Monitor): { text: string; tone: "neutral" | "warning" | "danger" } {
  if (m.schedule_error) return { text: `Its schedule has a problem: ${m.schedule_error}`, tone: "danger" };
  if (m.ends_at && Date.parse(m.ends_at) <= Date.now()) return { text: "Ended. Edit it to set a new end date.", tone: "neutral" };
  if (!m.active) return { text: "Paused. Nothing new joins until you resume it.", tone: "neutral" };
  const last = m.last_check;
  if (!last) return { text: "Not run yet", tone: "neutral" };
  if (last.status === "sourcing") return { text: "Running now", tone: "neutral" };
  if (last.status === "failed") return { text: `Last run ${ago(last.updated_at)} failed${last.error ? `: ${last.error.replace(/[.\s]+$/, "")}` : ""}`, tone: "danger" };
  return { text: `Last run ${ago(last.updated_at)}`, tone: "neutral" };
}

const TONE = { neutral: "text-muted-foreground", warning: "text-warning", danger: "text-destructive" } as const;

/**
 * One signal as one compact row: its name, what it finds and how often, and
 * where it stands. The prompt and the last run's report wait under Details:
 * printed in full, five signals made a wall of text.
 */
export function SignalRow({ monitor: m, onChanged, extra }: { monitor: Monitor; onChanged: () => void; extra?: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState(false);
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
  const status = signalStatus(m);
  return <div className="border-b border-border px-4 py-3 last:border-0">
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
      {m.kind === "custom"
        ? <Activity size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        : <img src={import.meta.env.VITE_LINKEDIN_LOGO_URL} alt="" width={16} height={16} className="mt-0.5 shrink-0" />}
      <div className="min-w-[12rem] flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium" title={m.name}>{m.name}</span>
          {running && <Badge tone="neutral">Running</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{signalSummary(m)}</p>
        <p className={`mt-0.5 text-xs ${TONE[status.tone]}`}>{status.text}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button disabled={busy || running || !m.active || expired} onClick={() => void act(async () => {
          const key = checkKey.current ?? crypto.randomUUID(); checkKey.current = key;
          await api.runMonitor(m.id, key); checkKey.current = null;
        })}>Run now</Button>
        <Tooltip label="Edit"><Button variant="ghost" size="icon" aria-label={`Edit ${m.name}`} disabled={busy} onClick={() => setEditing(true)}><Pencil size={16} /></Button></Tooltip>
        <Tooltip label={m.active ? "Pause" : "Resume"}>
          <Button variant="ghost" size="icon" aria-label={`${m.active ? "Pause" : "Resume"} ${m.name}`} disabled={busy || (expired && !m.active)} onClick={() => void act(() => api.toggleMonitor(m.id, !m.active))}>
            {m.active ? <Pause size={16} /> : <Play size={16} />}
          </Button>
        </Tooltip>
        {extra}
      </div>
    </div>
    <button type="button" className="ml-7 mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" aria-expanded={details} onClick={() => setDetails(v => !v)}>
      {details ? <ChevronDown size={12} /> : <ChevronRight size={12} />}Details
    </button>
    {details && <div className="ml-7 mt-2 max-w-3xl space-y-2 text-xs text-muted-foreground">
      <p className="whitespace-pre-wrap break-words text-foreground">{m.source}</p>
      {m.icp && <p><span className="font-medium text-foreground">Looks for: </span>{m.icp}</p>}
      {m.who_to_contact && <p><span className="font-medium text-foreground">Who to contact: </span>{m.who_to_contact}</p>}
      {m.ends_at && <p><span className="font-medium text-foreground">Stops: </span>{new Date(m.ends_at).toLocaleString()}</p>}
      {m.last_check?.coverage && <p className="whitespace-pre-wrap break-words"><span className="font-medium text-foreground">Last run: </span>{m.last_check.coverage}</p>}
      {running && <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void act(() => api.interruptCheck(m.last_check!.id))}>Interrupt run</Button>
        <span>Stops this run taking new results; it does not end the agent's session.</span>
      </div>}
    </div>}
    {(m.schedule_error || error) && <div className="ml-7 mt-2 flex flex-wrap items-center gap-2">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {m.schedule_error && !m.schedule_id && <Button disabled={busy} onClick={() => void act(() => api.createMonitor(id, cfg))}>Retry schedule setup</Button>}
      {m.schedule_error && !m.active && m.schedule_id && <Button disabled={busy} onClick={() => void act(() => api.toggleMonitor(m.id, false))}>Retry schedule pause</Button>}
    </div>}
    {/* Mounted only while open, so it starts from the saved settings each time. */}
    {editing && <EditMonitor monitor={m} open onOpenChange={setEditing} onSaved={() => { setEditing(false); onChanged(); }} />}
  </div>;
}

/** To review: the signals that feed no list, each with a way into one. */
export function UnlistedSignals({ action }: { action: (m: Monitor, reload: () => void) => ReactNode }) {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const r = await api.monitors(page, true); setMonitors(r.monitors); setTotal(r.total); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [page]);
  useEffect(() => {
    void load(); const timer = window.setInterval(() => void load(), 15000);
    const changed = () => void load(); window.addEventListener("monitors-changed", changed);
    return () => { clearInterval(timer); window.removeEventListener("monitors-changed", changed); };
  }, [load]);
  if (!error && total === 0) return null;
  return <section aria-label="Searches in no list">
    <h2 className="card-title">Searches in no list <span className="text-muted-foreground">{total}</span></h2>
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    {monitors.length > 0 && <Card className="mt-3">{monitors.map(m => <SignalRow key={m.id} monitor={m} onChanged={() => void load()} extra={action(m, () => void load())} />)}</Card>}
    <Pager page={page} total={total} onPage={setPage} />
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
    ? <Link className="underline" to={`/leads?run=${search.id}`}>{search.lead_count} {search.lead_count === 1 ? "person" : "people"} to contact</Link>
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
      <p className="text-sm"><span className="font-medium">Why: </span>{item.reason}</p>
    </> : <>
    <div className="flex flex-wrap items-center gap-2"><a className="text-sm font-medium underline" href={item.profile_url} target="_blank" rel="noreferrer">{item.person_name}</a>{item.company && <Chip>{item.company}</Chip>}<Badge>{item.engagement}</Badge></div>
    {item.quote && <blockquote className="text-sm">“{item.quote}”</blockquote>}
    <p className="text-sm"><span className="font-medium">ICP fit: </span>{item.why_fit}</p>
    <p className="text-sm"><span className="font-medium">Outreach context: </span>{item.outreach_context}</p>
    </>}
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><a className="underline" href={item.source_url} target="_blank" rel="noreferrer">View evidence</a><span>{item.occurred_at ? `Event: ${item.occurred_at}` : "Event date unknown"}</span><span>Found {ago(item.observed_at)}</span></div>
    {"kind" in item && item.subject.type === "company" && <CompanyPeople item={item} search={item.search} onChanged={onChanged} />}
    {!("kind" in item && item.subject.type === "company") && (item.lead_id ? <Link className="text-sm underline" to="/leads">In Leads</Link> : <Button disabled={busy} onClick={() => { setBusy(true); setError(null); void api.promoteObservation(item.id).then(onChanged).catch(e => setError(e.message)).finally(() => setBusy(false)); }}><Plus size={14} />Add to leads</Button>)}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </article>;
}

/** What the searches in no list found, waiting for a person. */
export function MonitorFindings() {
  const [items, setItems] = useState<Observation[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const r = await api.observations(page, true); setItems(r.observations); setTotal(r.total); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [page]);
  useEffect(() => {
    void load(); const timer = setInterval(() => void load(), 15000);
    // A search put in a list takes its findings off this page at once.
    const changed = () => void load(); window.addEventListener("review-changed", changed);
    return () => { clearInterval(timer); window.removeEventListener("review-changed", changed); };
  }, [load]);
  return <section aria-label="Findings to review"><h2 className="card-title">Findings <span className="text-muted-foreground">{total}</span></h2>
    {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : items.length === 0 ? <Empty title="Nothing to review" hint="What a search in no list finds waits here, with its evidence, and so do the companies of a search set not to find who to contact. Searches in a list add the rest to it on their own." /> : items.map(item => <Finding key={item.id} item={item} onChanged={() => void load()} />)}
    <Pager page={page} total={total} onPage={setPage} />
  </section>;
}
