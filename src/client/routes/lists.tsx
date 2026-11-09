// Lists: the home of the app. A list holds leads and the searches that fill
// it, each on its own repeat, and a campaign reads new leads from it. The
// leads are the page, the searches that fill it sit above them, and an empty
// list opens on "who should this list find?".

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Command } from "cmdk";
import { Activity, ChevronRight, Compass, ExternalLink, ListPlus, Plus, Search, Trash2, X } from "lucide-react";
import {
  api,
  type ListMember,
  type ListSource,
  type ProspectList,
  type Refresh,
  type Run,
} from "../api";
import { MONITOR_TEMPLATES, type Monitor, type MonitorKind } from "../../shared/monitors";
import { isInbox } from "../../shared/inbox";
import { Badge, Button, Card, CardTitle, Chip, Dialog, Empty, Picker, Popover, PopoverContent, PopoverTrigger, Tooltip, Zone } from "../components/ui";
import { StatusBadge } from "../components/leads-table";
import { MonitorForm, REPEAT_LABELS, SignalRow, addedMessage } from "../components/signal-monitors";
import { ago, until } from "../time";

const REPEAT_OPTIONS: { value: Refresh; label: string }[] = [
  { value: "off", label: "Run once" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "biweekly", label: "Every 2 weeks" },
];
/** Every hour is no longer offered, but a search set to it before keeps showing it. */
const repeatOptions = (current: Refresh) =>
  current === "hourly" ? [...REPEAT_OPTIONS, { value: "hourly" as const, label: "Every hour" }] : REPEAT_OPTIONS;

type Notice = { tone: "success" | "danger"; text: string } | null;

function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
      <h1 className="min-w-0 truncate text-[1.375rem] font-semibold tracking-[-0.01em]">{title}</h1>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </header>
  );
}

function NoticeBar({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <div
      role="status"
      className={`rounded-sm px-3 py-2 text-sm ${notice.tone === "success" ? "bg-success-tint text-success" : "bg-destructive-tint text-destructive"}`}
    >
      {notice.text}
    </div>
  );
}

const TH = "h-8 px-4 text-left text-xs font-medium text-muted-foreground";

/** The daily lookups as typed: a number from 0 to 1000, or empty for none of its own. */
function parseCap(v: string): number | null | "invalid" {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.max(0, Math.min(1000, Math.round(n))) : "invalid";
}

// ── The index (the app's home) ──────────────────────────────────────

export function ListsIndex() {
  const navigate = useNavigate();
  const [lists, setLists] = useState<ProspectList[] | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [cap, setCap] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .lists(1, 100)
      .then((r) => setLists(r.lists))
      .catch((e) => {
        setLists([]);
        setNotice({ tone: "danger", text: (e as Error).message });
      });
  }, []);

  async function create() {
    const daily = parseCap(cap);
    if (!name.trim() || daily === "invalid") return;
    setSaving(true);
    try {
      const { list } = await api.createList({ name: name.trim(), email_daily_cap: daily });
      navigate(`/lists/${list.id}`);
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader title="Lists">
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> New list
        </Button>
      </PageHeader>

      {notice ? (
        <div className="px-6 pt-6">
          <NoticeBar notice={notice} />
        </div>
      ) : null}

      {lists === null ? (
        <div className="space-y-2 px-6 py-6" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-sm bg-muted" />
          ))}
        </div>
      ) : lists.length === 0 ? (
        <Empty
          title="No lists yet"
          hint="A list fills itself. Tell it who to find and how often to look, and new leads join it with the evidence of why they fit. A campaign can then take a few new ones every day."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={`${TH} pl-6`}>Name</th>
                <th className={`${TH} hidden text-right md:table-cell`}>Searches</th>
                <th className={`${TH} text-right`}>Leads</th>
                <th className={`${TH} hidden text-right sm:table-cell`}>Verified emails</th>
                <th className={`${TH} hidden text-right md:table-cell`}>Emails a day</th>
                <th className={`${TH} w-10 pr-6`} />
              </tr>
            </thead>
            <tbody>
              {lists.map((l) => (
                <tr
                  key={l.id}
                  className="group h-11 cursor-pointer border-b border-border hover:bg-muted"
                  onClick={() => navigate(`/lists/${l.id}`)}
                >
                  <td className="px-4 py-2 pl-6 font-medium">
                    <Link to={`/lists/${l.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                      {l.name}
                    </Link>
                  </td>
                  <td className="data hidden px-4 py-2 text-right md:table-cell">{l.source_count}</td>
                  <td className="data px-4 py-2 text-right">{l.member_count.toLocaleString()}</td>
                  <td className="data hidden px-4 py-2 text-right sm:table-cell">{l.verified_count.toLocaleString()}</td>
                  <td className="data hidden px-4 py-2 text-right md:table-cell">
                    {l.effective_daily_cap > 0 ? `${l.lookups_today} of ${l.effective_daily_cap}` : <span className="text-faint">none</span>}
                  </td>
                  <td className="px-4 py-2 pr-6 text-right text-muted-foreground">
                    <ChevronRight size={16} className="invisible group-hover:visible" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New list"
        description="Next you tell it who to find. New leads join it on their own."
        submitLabel="Create list"
        submitting={saving || !name.trim() || parseCap(cap) === "invalid"}
        onSubmit={() => void create()}
      >
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Dutch building firms" className="input text-sm" maxLength={120} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Emails looked up a day (optional)</span>
          <input
            inputMode="numeric"
            value={cap}
            onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="None"
            className="input data w-32 text-sm"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            New leads without an email are looked up with your email providers, up to this many a day. Left empty, none are, until you set it or a campaign reads the list.
          </span>
        </label>
      </Dialog>
    </div>
  );
}

// ── One list ────────────────────────────────────────────────────────

type Detail = Awaited<ReturnType<typeof api.list>>;

/** An error as the end of a sentence: no doubled full stop. */
const because = (error: string) => (error ? `: ${error.replace(/[.\s]+$/, "")}` : "");

/** Where a search's re-runs stand, in one line. */
function searchLine(s: ListSource): { text: string; tone: "neutral" | "warning" | "danger" } {
  if (s.missing) return { text: "This search was deleted", tone: "warning" };
  const last = s.last_refresh;
  if (!last) return { text: s.refresh && s.refresh !== "off" ? "Not run again yet" : "Ran when it was started", tone: "neutral" };
  switch (s.hold) {
    case "stalled":
      return { text: `The run ${ago(last.created_at)} stopped reporting. Run now starts another.`, tone: "warning" };
    case "failed":
      return { text: `The run ${ago(last.created_at)} failed${because(last.error)}. Run now tries again.`, tone: "danger" };
    case "undelivered":
      return { text: `The run ${ago(last.created_at)} couldn't reach the agent${because(last.error)}. Run now tries again.`, tone: "danger" };
    case "working":
      return { text: `Running since ${ago(last.created_at)}`, tone: "neutral" };
    default:
      return { text: `Last run ${ago(last.created_at)}, ${last.lead_count} found`, tone: "neutral" };
  }
}

const TONE = { neutral: "text-muted-foreground", warning: "text-warning", danger: "text-destructive" } as const;

function RemoveSource({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <Tooltip label="Remove from this list. The leads it added stay.">
      <Button variant="ghost" size="icon" onClick={onRemove} aria-label={`Remove ${name}`}>
        <X size={16} />
      </Button>
    </Tooltip>
  );
}

/** A search (a described profile or a Sales Navigator export) and how often this list runs it again. */
function SearchRow({ listId, source, act, onRemove }: { listId: string; source: ListSource; act: (fn: () => Promise<unknown>, success?: string) => Promise<void>; onRemove: () => void }) {
  const line = searchLine(source);
  const salesNav = source.search_source === "sales_navigator";
  const repeat = source.refresh ?? "off";
  const [running, setRunning] = useState(false);
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-border px-4 py-3 last:border-0">
      {salesNav ? <Compass size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden /> : <Search size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />}
      <div className="min-w-[12rem] flex-1">
        <span className="line-clamp-2 text-sm font-medium" title={source.name}>
          {salesNav ? "Sales Navigator export" : source.name}
        </span>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {salesNav ? "Exports the list again" : "Finds people"} · {REPEAT_LABELS[repeat]}
          {repeat !== "off" && source.next_refresh_at ? `, next ${until(source.next_refresh_at)}` : ""}
        </p>
        <p className={`mt-0.5 text-xs ${TONE[line.tone]}`}>{line.text}</p>
      </div>
      {!source.missing ? (
        <div className="flex shrink-0 items-center gap-1">
          <Picker
            kind="view"
            label="Repeat"
            value={repeat}
            options={repeatOptions(repeat)}
            onChange={(v) => void act(() => api.setSearchRefresh(listId, source.source_id, v as Refresh), "Saved.")}
          />
          <Button
            disabled={running || source.hold === "working"}
            onClick={async () => {
              setRunning(true);
              await act(async () => {
                const r = await api.runListSearch(listId, source.source_id);
                if (r.failed > 0) throw new Error("Couldn't hand it to your agent. The reason is on the search.");
              }, "Handed to your agent. New leads join as they are found.");
              setRunning(false);
            }}
          >
            Run now
          </Button>
          <RemoveSource name={source.name} onRemove={onRemove} />
        </div>
      ) : (
        <RemoveSource name={source.name} onRemove={onRemove} />
      )}
    </div>
  );
}

type Adding = null | "find" | "linkedin" | MonitorKind | "salesnav" | "existing";

/** The ways a list can fill, as a menu once it has a search. */
function AddSearchMenu({ onPick }: { onPick: (a: Adding) => void }) {
  const [open, setOpen] = useState(false);
  const pick = (a: Adding) => {
    setOpen(false);
    onPick(a);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button>
          <Plus size={16} /> Add search
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1">
        <WaysToFill onPick={pick} />
      </PopoverContent>
    </Popover>
  );
}

const WAYS: { id: Adding; icon: ReactNode; title: string; hint: string }[] = [
  { id: "find", icon: <Activity size={16} />, title: "Companies or people", hint: "Describe who. Your agent researches the web, on a repeat." },
  { id: "linkedin", icon: <img src={import.meta.env.VITE_LINKEDIN_LOGO_URL} alt="" width={16} height={16} />, title: "LinkedIn engagement", hint: "People who comment on or react to posts." },
  { id: "salesnav", icon: <Compass size={16} />, title: "Sales Navigator list", hint: "Export a saved search or lead list." },
  { id: "existing", icon: <ListPlus size={16} />, title: "One you already have", hint: "A search or signal you made before." },
];

function WaysToFill({ onPick, skip }: { onPick: (a: Adding) => void; skip?: Adding }) {
  return (
    <div className="flex flex-col">
      {WAYS.filter((w) => w.id !== skip).map((w) => (
        <button
          key={String(w.id)}
          type="button"
          onClick={() => onPick(w.id)}
          className="flex items-start gap-2.5 rounded-sm px-2 py-2 text-left hover:bg-muted"
        >
          <span className="mt-0.5 text-muted-foreground">{w.icon}</span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">{w.title}</span>
            <span className="block text-xs text-muted-foreground">{w.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function LinkedinTemplates({ onPick, onClose }: { onPick: (k: MonitorKind) => void; onClose: () => void }) {
  return (
    <Card className="mt-4">
      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="card-title">LinkedIn engagement</h2>
            <p className="mt-1 text-sm text-muted-foreground">Your agent watches posts in its own signed-in LinkedIn browser.</p>
          </div>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {MONITOR_TEMPLATES.map((t) => (
            <button key={t.id} type="button" onClick={() => onPick(t.id)} className="card min-w-0 p-4 text-left transition-colors hover:bg-muted">
              <img src={import.meta.env.VITE_LINKEDIN_LOGO_URL} alt="LinkedIn" width={22} height={22} className="mb-3" />
              <span className="block text-sm font-medium">{t.title}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{t.description}</span>
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}

/** A Sales Navigator export made inside the list: saved, added with its repeat, then handed to the agent. */
function SalesNavForm({ listId, onClose, onSaved }: { listId: string; onClose: () => void; onSaved: (message: string) => void }) {
  const [url, setUrl] = useState("");
  const [emails, setEmails] = useState(true);
  const [repeat, setRepeat] = useState<Refresh>("off");
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      let id = runId;
      if (!id) {
        id = (await api.createSalesNavRun(url.trim(), emails)).run.id;
        await api.addListSource(listId, "search", id, repeat);
        setRunId(id);
      }
      await api.dispatchRun(id);
      onSaved("Handed to your agent. The people it exports join this list.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="mt-4">
      <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="card-title">Sales Navigator list</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A lead search, saved search or lead list. Your agent opens it in its own browser, signed in to Sales Navigator, and exports up to 2,500 people. It stops if LinkedIn asks it to sign in or slow down.
            </p>
          </div>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
        </div>
        <fieldset disabled={busy || Boolean(runId)} className="space-y-4 disabled:opacity-60">
          <label className="block text-sm">
            <span className="sr-only">Sales Navigator link</span>
            <input type="url" inputMode="url" required autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.linkedin.com/sales/search/people?savedSearchId=…" className="input w-full text-sm" />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input className="mt-1 accent-primary" type="checkbox" checked={emails} onChange={(e) => setEmails(e.target.checked)} />
            <span>
              Find work emails for the first export
              <span className="block text-xs text-muted-foreground">
                {emails ? "Found and verified with your email providers once the list is in. Later exports use the list's daily number." : "Names, titles, profile links and company details only. No credits are used."}
              </span>
            </span>
          </label>
          <div className="w-48 text-sm">
            Repeat
            <Picker label="Repeat" value={repeat} options={REPEAT_OPTIONS} onChange={(v) => setRepeat(v as Refresh)} className="mt-1 w-full" />
          </div>
        </fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !url.trim()}>{busy ? "Starting…" : runId ? "Retry" : "Add to list"}</Button>
        </div>
      </form>
    </Card>
  );
}

/** Searches and signals made before, to add to this list. */
function ExistingPicker({ listId, existing, onClose, onAdded }: { listId: string; existing: ListSource[]; onClose: () => void; onAdded: (message: string) => void }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [monitors, setMonitors] = useState<Monitor[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.runs(1, { searchesOnly: true, limit: 100 }), api.monitors(1)])
      .then(([r, m]) => {
        setRuns(r.runs);
        setMonitors(m.monitors);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const has = (kind: string, id: string) => existing.some((s) => s.kind === kind && s.source_id === id);

  async function add(kind: "search" | "signal", id: string) {
    setError(null);
    try {
      const r = await api.addListSource(listId, kind, id);
      onAdded(kind === "signal" ? addedMessage(r.added, r.searching, r.contacts) : `Added.${r.added ? ` ${r.added} ${r.added === 1 ? "lead" : "leads"} it already found joined this list.` : ""} It runs once; set it to repeat on its row.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const item = "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:cursor-default data-[disabled=true]:opacity-50 data-[selected=true]:bg-muted";
  const group = "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground";
  return (
    <Card className="mt-4">
      <div className="p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="card-title">One you already have</h2>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <Command label="Add a search you already have">
          <Command.Input autoFocus placeholder="Search your searches and signals" className="input mb-1 h-8 text-sm" />
          <Command.List className="max-h-72 overflow-y-auto">
            {runs === null || monitors === null ? (
              <Command.Loading>
                <div className="px-2 py-1.5 text-sm text-muted-foreground">{error ?? "Loading"}</div>
              </Command.Loading>
            ) : null}
            <Command.Empty className="px-2 py-1.5 text-sm text-muted-foreground">Nothing matches</Command.Empty>
            {monitors && monitors.length ? (
              <Command.Group heading="Repeating searches (signals)" className={group}>
                {monitors.map((m) => (
                  <Command.Item key={m.id} value={`signal ${m.name} ${m.id}`} disabled={has("signal", m.id)} onSelect={() => void add("signal", m.id)} className={item}>
                    <Activity size={14} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{m.name}</span>
                    {has("signal", m.id) ? <span className="text-xs text-muted-foreground">added</span> : m.lists_fed ? <span className="text-xs text-muted-foreground">in {m.lists_fed} {m.lists_fed === 1 ? "list" : "lists"}</span> : null}
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
            {runs && runs.length ? (
              <Command.Group heading="Searches from Leads" className={group}>
                {runs.map((r) => (
                  <Command.Item key={r.id} value={`search ${r.icp_prompt} ${r.id}`} disabled={has("search", r.id)} onSelect={() => void add("search", r.id)} className={item}>
                    {r.source === "sales_navigator" ? <Compass size={14} className="shrink-0 text-muted-foreground" /> : <Search size={14} className="shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">{r.source === "sales_navigator" ? "Sales Navigator export" : r.icp_prompt}</span>
                    {has("search", r.id) ? <span className="text-xs text-muted-foreground">added</span> : null}
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
          </Command.List>
          {error && runs !== null ? <p className="px-2 py-1.5 text-xs text-destructive">{error}</p> : null}
        </Command>
      </div>
    </Card>
  );
}

/** Why a lead fits, from its evidence: the reasoning, without the profile line a signal adds. */
function why(m: ListMember): string {
  return (m.evidence || "")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("Profile: "))
    .join(" ");
}

function foundBy(m: ListMember): string {
  if (m.source_kind === "manual") return "Added by hand";
  return m.source_name ?? (m.source_kind === "search" ? "A deleted search" : "A deleted signal");
}

/** A lead nobody has looked up yet: queued while the list looks up emails, else said plainly. */
function MemberStatus({ member, lookups }: { member: ListMember; lookups: boolean }) {
  if (member.enrich_status === "pending") return <Badge tone="neutral">{lookups ? "Queued" : "Not looked up"}</Badge>;
  return <StatusBadge lead={member} />;
}

export function ListDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [members, setMembers] = useState<{ members: ListMember[]; total: number; limit: number } | null>(null);
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<Notice>(null);
  const [cap, setCap] = useState("");
  const [deleting, setDeleting] = useState(false);
  // What is being added. An empty list opens on finding companies or people;
  // closing it shows the other ways in.
  const [adding, setAdding] = useState<Adding>(null);
  const [dismissed, setDismissed] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.list(id);
      setDetail(d);
      setCap(d.list.email_daily_cap === null ? "" : String(d.list.email_daily_cap));
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    }
  }, [id]);

  const loadMembers = useCallback(async () => {
    try {
      setMembers(await api.listMembers(id, page));
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    }
  }, [id, page]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);
  useEffect(() => {
    const changed = () => void load();
    window.addEventListener("monitors-changed", changed);
    return () => window.removeEventListener("monitors-changed", changed);
  }, [load]);

  // Poll only while one of its searches is running: new leads arrive then.
  const running = (detail?.sources ?? []).some((s) => s.monitor?.last_check?.status === "sourcing" || s.hold === "working");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      void load();
      void loadMembers();
    }, 15_000);
    return () => clearInterval(t);
  }, [running, load, loadMembers]);

  async function act(fn: () => Promise<unknown>, success?: string) {
    try {
      await fn();
      if (success) setNotice({ tone: "success", text: success });
      await Promise.all([load(), loadMembers()]);
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
      await load();
    }
  }

  async function saveCap() {
    const next = parseCap(cap);
    if (next === "invalid") {
      setNotice({ tone: "danger", text: "The emails a day are a number from 0 to 1000, or empty for none of its own." });
      return;
    }
    if (detail && next === detail.list.email_daily_cap) return;
    await act(() => api.updateList(id, { email_daily_cap: next }), "Saved.");
  }

  const saved = (message: string) => {
    setAdding(null);
    setDismissed(true);
    void act(async () => undefined, message);
  };

  if (!detail) {
    return (
      <div className="flex min-h-full flex-col">
        <PageHeader title={<Link to="/" className="text-muted-foreground hover:text-foreground">Lists</Link>} />
        <div className="px-6 py-6">
          <NoticeBar notice={notice} />
          {notice ? null : <div className="h-40 animate-pulse rounded-md bg-muted" aria-busy="true" />}
        </div>
      </div>
    );
  }

  const { list, sources, consumers, cap_from } = detail;
  const pages = members ? Math.max(1, Math.ceil(members.total / members.limit)) : 1;
  const open: Adding = adding ?? (sources.length === 0 && !dismissed ? "find" : null);
  const close = () => {
    setAdding(null);
    setDismissed(true);
  };
  const lookups = list.effective_daily_cap > 0;
  const remove = (s: ListSource) => () => void act(() => api.removeListSource(id, s.kind, s.source_id), "Removed. The leads it added stay.");

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-1.5">
            <Link to="/" className="text-muted-foreground hover:text-foreground">Lists</Link>
            <ChevronRight size={18} className="text-faint" />
            <span className="truncate">{list.name}</span>
          </span>
        }
      >
        <Tooltip label="Delete list">
          <Button variant="ghost" size="icon" onClick={() => setDeleting(true)} aria-label="Delete list">
            <Trash2 size={16} />
          </Button>
        </Tooltip>
      </PageHeader>

      <div className="px-6 py-6">
        <NoticeBar notice={notice} />

        {/* An empty list opens straight on "who should this list find?"; the
            searches card appears once something fills it. */}
        {sources.length === 0 && open ? null : (
        <Card className={notice ? "mt-4" : ""}>
          <Zone className="py-3">
            <CardTitle right={sources.length ? <AddSearchMenu onPick={setAdding} /> : undefined}>Searches</CardTitle>
          </Zone>
          {sources.length === 0 ? (
              <div className="px-2 py-2">
                <p className="px-2 pb-1 text-sm text-muted-foreground">Nothing fills this list yet. How should it find leads?</p>
                <WaysToFill onPick={setAdding} />
              </div>
          ) : (
            sources.map((s) =>
              s.kind === "signal" && s.monitor ? (
                <SignalRow key={`signal:${s.source_id}`} monitor={s.monitor} onChanged={() => void load()} extra={<RemoveSource name={s.name} onRemove={remove(s)} />} />
              ) : s.kind === "signal" ? (
                <div key={`signal:${s.source_id}`} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
                  <Activity size={16} className="text-muted-foreground" aria-hidden />
                  <span className="flex-1 text-sm text-warning">This signal was deleted</span>
                  <RemoveSource name={s.name} onRemove={remove(s)} />
                </div>
              ) : (
                <SearchRow key={`search:${s.source_id}`} listId={id} source={s} act={act} onRemove={remove(s)} />
              ),
            )
          )}
        </Card>
        )}

        {open === "find" ? <MonitorForm key="find" kind="custom" listId={id} listName={sources.length ? undefined : list.name} onClose={close} onSaved={saved} /> : null}
        {open === "linkedin" ? <LinkedinTemplates onPick={(k) => setAdding(k)} onClose={close} /> : null}
        {open && MONITOR_TEMPLATES.some((t) => t.id === open) ? <MonitorForm key={String(open)} kind={open as MonitorKind} listId={id} onClose={close} onSaved={saved} /> : null}
        {open === "salesnav" ? <SalesNavForm listId={id} onClose={close} onSaved={saved} /> : null}
        {open === "existing" ? <ExistingPicker listId={id} existing={sources} onClose={close} onAdded={saved} /> : null}
        {open === "find" && sources.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Or fill it from{" "}
            <button type="button" className="underline hover:text-foreground" onClick={() => setAdding("linkedin")}>LinkedIn engagement</button>,{" "}
            <button type="button" className="underline hover:text-foreground" onClick={() => setAdding("salesnav")}>a Sales Navigator list</button>, or{" "}
            <button type="button" className="underline hover:text-foreground" onClick={() => setAdding("existing")}>one you already have</button>.
          </p>
        ) : null}
      </div>

      <section className="flex flex-col border-t border-border">
        <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-6 py-2">
          <h2 className="card-title">Leads</h2>
          <span className="data text-[0.8125rem] text-muted-foreground">
            {list.member_count.toLocaleString()} · {list.verified_count.toLocaleString()} with a verified email
          </span>
          <label className="ml-auto flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Emails looked up a day</span>
            <input
              aria-label="Emails looked up a day"
              inputMode="numeric"
              value={cap}
              onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={() => void saveCap()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveCap();
              }}
              placeholder={cap_from === "consumers" ? `${list.effective_daily_cap} (campaigns)` : "None"}
              className="input data h-7 w-28 text-sm"
            />
            {lookups ? <span className="data text-xs text-muted-foreground">{list.lookups_today} today</span> : null}
          </label>
        </div>
        {!lookups && list.member_count > list.verified_count ? (
          <p className="border-b border-border bg-muted px-6 py-2 text-xs text-muted-foreground">
            Emails aren't looked up on their own. Set how many a day above, or let a campaign read this list.
          </p>
        ) : null}
        {consumers.length ? (
          <p className="border-b border-border px-6 py-2 text-xs text-muted-foreground">
            Read by {consumers.map((k) => `${k.name} (${k.daily} a day)`).join(", ")}
            {cap_from === "consumers" ? ". With no number of its own, it looks up what they take." : "."}
          </p>
        ) : null}
        {members && members.members.length === 0 ? (
          <Empty title="No leads yet" hint="They join as its searches find them. You can also select leads on the Leads page and add them here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={`${TH} pl-6`}>Name</th>
                  <th className={TH}>Company</th>
                  <th className={TH}>Email</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Why</th>
                  <th className={`${TH} pr-6`}>Found by</th>
                </tr>
              </thead>
              <tbody>
                {(members?.members ?? []).map((m) => (
                  <tr key={m.id} className="border-b border-border align-top hover:bg-muted">
                    <td className="px-4 py-2.5 pl-6">
                      <div className="font-medium">{m.full_name || (isInbox(m.email) ? <span className="text-muted-foreground">Company inbox</span> : <span className="text-faint">Unnamed</span>)}</div>
                      {m.title ? <div className="text-xs text-muted-foreground">{m.title}</div> : null}
                    </td>
                    <td className="px-4 py-2.5">
                      <div>{m.company || <span className="text-faint">Unknown</span>}</div>
                      {m.domain ? <div className="text-xs text-muted-foreground">{m.domain}</div> : null}
                    </td>
                    <td className="px-4 py-2.5">
                      {m.email ? (
                        <span className="flex items-center gap-1.5">
                          <a href={`mailto:${m.email}`} className="text-info hover:underline">{m.email}</a>
                          {m.email_verified ? null : <Chip>unverified</Chip>}
                        </span>
                      ) : (
                        <span className="text-faint">None yet</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <MemberStatus member={m} lookups={lookups} />
                    </td>
                    <td className="max-w-xs px-4 py-2.5">
                      {why(m) ? (
                        <span className="line-clamp-2 text-xs text-muted-foreground" title={why(m)}>
                          {why(m)}
                        </span>
                      ) : (
                        <span className="block text-xs text-faint">No reason recorded</span>
                      )}
                      {m.source_url ? (
                        <a href={m.source_url} target="_blank" rel="noreferrer noopener" className="mt-0.5 flex w-fit items-center gap-1 text-xs text-muted-foreground underline hover:text-foreground">
                          Evidence <ExternalLink size={11} aria-hidden />
                        </a>
                      ) : null}
                    </td>
                    <td className="max-w-[14rem] px-4 py-2.5 pr-6 text-xs text-muted-foreground">
                      <div className="truncate" title={foundBy(m)}>{foundBy(m)}</div>
                      <div className="text-faint">{ago(m.added_at)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pages > 1 ? (
              <div className="flex h-10 items-center justify-end gap-3 px-6 text-xs text-muted-foreground">
                <span>
                  Page <span className="data">{page}</span> of <span className="data">{pages}</span>
                </span>
                <Button onClick={() => setPage(page - 1)} disabled={page <= 1}>Previous</Button>
                <Button onClick={() => setPage(page + 1)} disabled={page >= pages}>Next</Button>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${list.name}?`}
        description="The list and its settings go. Its searches stay, as do its leads in Leads, and campaigns reading it stop getting new leads."
        submitLabel="Delete list"
        danger
        onSubmit={() =>
          void (async () => {
            try {
              await api.deleteList(id);
              navigate("/");
            } catch (e) {
              setDeleting(false);
              setNotice({ tone: "danger", text: (e as Error).message });
            }
          })()
        }
      />
    </div>
  );
}

/** Lead ids chosen on the Leads page go to a list. Shared by its selection bar. */
export function AddToList({ leadIds, onDone }: { leadIds: string[]; onDone: (text: string, tone: "success" | "danger") => void }) {
  const [lists, setLists] = useState<ProspectList[]>([]);
  useEffect(() => {
    api
      .lists(1, 100)
      .then((r) => setLists(r.lists))
      .catch(() => setLists([]));
  }, []);
  return (
    <Picker
      kind="view"
      label="Add to list"
      placeholder="Add to list"
      value=""
      empty="No lists yet. Create one on the Lists page."
      options={lists.map((l) => ({ value: l.id, label: l.name, hint: `${l.member_count}` }))}
      onChange={async (listId) => {
        try {
          const { added } = await api.addToList(listId, leadIds);
          const name = lists.find((l) => l.id === listId)?.name ?? "the list";
          const skipped = leadIds.length - added;
          onDone(
            `Added ${added} to ${name}.${skipped ? ` ${skipped} ${skipped === 1 ? "was" : "were"} already in it.` : ""}`,
            "success",
          );
        } catch (e) {
          onDone((e as Error).message, "danger");
        }
      }}
    />
  );
}

/** To review: put a search that feeds no list into one, so what it finds joins it from now on. */
export function PutInList({ monitorId, onDone }: { monitorId: string; onDone: (text: string, tone: "success" | "danger") => void }) {
  const [lists, setLists] = useState<ProspectList[]>([]);
  useEffect(() => {
    api
      .lists(1, 100)
      .then((r) => setLists(r.lists))
      .catch(() => setLists([]));
  }, []);
  return (
    <Picker
      kind="view"
      label="Add to a list"
      placeholder="Add to a list"
      value=""
      empty="No lists yet. Create one on the Lists page."
      options={lists.map((l) => ({ value: l.id, label: l.name }))}
      onChange={async (listId) => {
        try {
          const r = await api.addListSource(listId, "signal", monitorId);
          const name = lists.find((l) => l.id === listId)?.name ?? "the list";
          onDone(addedMessage(r.added, r.searching, r.contacts).replace("Added.", `Added to ${name}.`).replace("this list", name), "success");
        } catch (e) {
          onDone((e as Error).message, "danger");
        }
      }}
    />
  );
}
