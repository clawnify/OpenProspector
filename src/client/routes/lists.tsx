// Lists: people that keep arriving from searches and signals, for campaigns to
// read. The index is a table of lists; a list's page has its sources, how
// often its searches run again, how many emails it may look up a day, who
// reads it, and its people.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Command } from "cmdk";
import { Activity, ChevronRight, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import {
  api,
  type ListConsumer,
  type ListMember,
  type ListSource,
  type ProspectList,
  type Refresh,
  type Run,
} from "../api";
import type { Monitor } from "../../shared/monitors";
import { isInbox } from "../../shared/inbox";
import { Button, Card, CardTitle, Chip, Dialog, Empty, Picker, Popover, PopoverContent, PopoverTrigger, Tooltip, Zone } from "../components/ui";
import { StatusBadge } from "../components/leads-table";

const REFRESH_OPTIONS: { value: Refresh; label: string }[] = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "off", label: "Only when I refresh" },
];
const refreshLabel = (r: Refresh) => REFRESH_OPTIONS.find((o) => o.value === r)?.label ?? r;

/** SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) or an ISO string, as a Date. */
function parse(at: string): Date {
  return new Date(at.includes("T") ? at : `${at.replace(" ", "T")}Z`);
}

function ago(at: string | null): string {
  if (!at) return "never";
  const s = Math.round((Date.now() - parse(at).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return parse(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function until(at: string | null): string {
  if (!at) return "not scheduled";
  const s = Math.round((parse(at).getTime() - Date.now()) / 1000);
  if (s <= 60) return "in a moment";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return parse(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
      <h1 className="min-w-0 truncate text-[1.375rem] font-semibold tracking-[-0.01em]">{title}</h1>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </header>
  );
}

function Notice({ notice }: { notice: { tone: "success" | "danger"; text: string } | null }) {
  if (!notice) return null;
  return (
    <div
      role="status"
      className={`mb-5 rounded-sm px-3 py-2 text-sm ${notice.tone === "success" ? "bg-success-tint text-success" : "bg-destructive-tint text-destructive"}`}
    >
      {notice.text}
    </div>
  );
}

const TH = "h-8 px-4 text-left text-xs font-medium text-muted-foreground";

// ── The index ───────────────────────────────────────────────────────

export function ListsIndex() {
  const navigate = useNavigate();
  const [lists, setLists] = useState<ProspectList[] | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [refresh, setRefresh] = useState<Refresh>("daily");
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
    if (!name.trim()) return;
    setSaving(true);
    try {
      const { list } = await api.createList({ name: name.trim(), refresh });
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
          <Notice notice={notice} />
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
          hint="A list keeps filling from your searches and signals, and a campaign can read new people from it every day."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={`${TH} pl-6`}>Name</th>
                <th className={TH}>Refresh</th>
                <th className={`${TH} text-right`}>People</th>
                <th className={`${TH} text-right`}>Verified emails</th>
                <th className={`${TH} text-right`}>Lookups today</th>
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
                  <td className="px-4 py-2 text-muted-foreground">
                    {refreshLabel(l.refresh)}
                    {l.next_refresh_at ? <span className="text-faint"> · next {until(l.next_refresh_at)}</span> : null}
                  </td>
                  <td className="data px-4 py-2 text-right">{l.member_count.toLocaleString()}</td>
                  <td className="data px-4 py-2 text-right">{l.verified_count.toLocaleString()}</td>
                  <td className="data px-4 py-2 text-right">
                    {l.effective_daily_cap > 0 ? `${l.lookups_today} of ${l.effective_daily_cap}` : <span className="text-faint">none set</span>}
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
        description="Add searches and signals to it once it exists. New people they find join it on their own."
        submitLabel="Create list"
        submitting={saving || !name.trim()}
        onSubmit={() => void create()}
      >
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Dutch building firms" className="input text-sm" maxLength={120} />
        </label>
        <div className="text-sm">
          <span className="mb-1 block font-medium">Run its searches again</span>
          <Picker label="Refresh" value={refresh} options={REFRESH_OPTIONS} onChange={(v) => setRefresh(v as Refresh)} />
        </div>
      </Dialog>
    </div>
  );
}

// ── One list ────────────────────────────────────────────────────────

type Detail = Awaited<ReturnType<typeof api.list>>;

/** An error as the end of a sentence: no doubled full stop. */
const because = (error: string) => (error ? `: ${error.replace(/[.\s]+$/, "")}` : "");

function sourceLine(s: ListSource): { text: string; tone: "neutral" | "warning" | "danger" } {
  if (s.missing) return { text: s.kind === "search" ? "This search was deleted" : "This signal was deleted", tone: "warning" };
  if (s.kind === "signal") {
    if (s.schedule_error) return { text: `Its schedule has a problem: ${s.schedule_error}`, tone: "danger" };
    if (s.active === false) return { text: "Paused. New people join again when it is resumed.", tone: "neutral" };
    const freq = s.frequency === "daily" ? "Checks every day" : s.frequency === "weekly" ? "Checks every week" : "Checks when you run it";
    return { text: `${freq}, on its own schedule. New people it finds join without review, and so do the people found at the companies it finds.`, tone: "neutral" };
  }
  const last = s.last_refresh;
  if (!last) return { text: "Not run again yet", tone: "neutral" };
  switch (s.hold) {
    case "stalled":
      return { text: `The re-run ${ago(last.created_at)} stopped reporting. Refresh now starts another.`, tone: "warning" };
    case "failed":
      return { text: `The re-run ${ago(last.created_at)} failed${because(last.error)}. Refresh now tries again.`, tone: "danger" };
    case "undelivered":
      return { text: `The re-run ${ago(last.created_at)} couldn't reach the agent${because(last.error)}. Refresh now tries again.`, tone: "danger" };
    case "working":
      return { text: `Running again since ${ago(last.created_at)}`, tone: "neutral" };
    default:
      return { text: `Ran again ${ago(last.created_at)}, ${last.lead_count} found`, tone: "neutral" };
  }
}

/** Searches and signals to add, in one combobox with a group each. */
/**
 * What attaching a source did: people who joined, and companies it found whose
 * people are being looked for, or, on a signal set not to look, are waiting.
 */
function addedMessage(added: number, searching: number, contacts: boolean): string {
  const people = added ? ` ${added} ${added === 1 ? "person" : "people"} it already found joined.` : "";
  const companies = searching ? ` Finding who to contact at ${searching} ${searching === 1 ? "company" : "companies"} it found.` : "";
  const waiting = contacts ? "" : " Its companies wait on Signals: press Find people on the ones you want, and their people join this list.";
  return `Added.${people}${companies}${waiting}`;
}

function AddSource({ listId, existing, onAdded }: { listId: string; existing: ListSource[]; onAdded: (added: number, searching: number, contacts: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [monitors, setMonitors] = useState<Monitor[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    Promise.all([api.runs(1, { searchesOnly: true, limit: 100 }), api.monitors(1)])
      .then(([r, m]) => {
        setRuns(r.runs);
        setMonitors(m.monitors);
      })
      .catch((e) => setError((e as Error).message));
  }, [open]);

  const has = (kind: string, id: string) => existing.some((s) => s.kind === kind && s.source_id === id);

  async function add(kind: "search" | "signal", id: string) {
    setOpen(false);
    try {
      const r = await api.addListSource(listId, kind, id);
      onAdded(r.added, r.searching, r.contacts);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button>
          <Plus size={16} /> Add source
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <Command label="Add a source">
          <Command.Input placeholder="Search your searches and signals" className="input mb-1 h-8 text-sm" />
          <Command.List className="max-h-72 overflow-y-auto">
            {runs === null || monitors === null ? (
              <Command.Loading>
                <div className="px-2 py-1.5 text-sm text-muted-foreground">{error ?? "Loading"}</div>
              </Command.Loading>
            ) : null}
            <Command.Empty className="px-2 py-1.5 text-sm text-muted-foreground">Nothing matches</Command.Empty>
            {runs && runs.length ? (
              <Command.Group heading="Searches" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
                {runs.map((r) => (
                  <Command.Item
                    key={r.id}
                    value={`search ${r.icp_prompt} ${r.id}`}
                    disabled={has("search", r.id)}
                    onSelect={() => void add("search", r.id)}
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:cursor-default data-[disabled=true]:opacity-50 data-[selected=true]:bg-muted"
                  >
                    <Search size={14} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{r.icp_prompt}</span>
                    {has("search", r.id) ? <span className="text-xs text-muted-foreground">added</span> : null}
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
            {monitors && monitors.length ? (
              <Command.Group heading="Signals" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
                {monitors.map((m) => (
                  <Command.Item
                    key={m.id}
                    value={`signal ${m.name} ${m.id}`}
                    disabled={has("signal", m.id)}
                    onSelect={() => void add("signal", m.id)}
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:cursor-default data-[disabled=true]:opacity-50 data-[selected=true]:bg-muted"
                  >
                    <Activity size={14} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{m.name}</span>
                    {has("signal", m.id) ? <span className="text-xs text-muted-foreground">added</span> : null}
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
          </Command.List>
          {error && runs !== null ? <p className="px-2 py-1.5 text-xs text-destructive">{error}</p> : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SourceRow({ source, onRemove }: { source: ListSource; onRemove: () => void }) {
  const line = sourceLine(source);
  const tone = { neutral: "text-muted-foreground", warning: "text-warning", danger: "text-destructive" }[line.tone];
  return (
    <div className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-0">
      <span className="mt-0.5 text-muted-foreground">{source.kind === "search" ? <Search size={16} /> : <Activity size={16} />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{source.name}</span>
          <Chip>{source.kind === "search" ? "Search" : "Signal"}</Chip>
        </div>
        <p className={`mt-0.5 text-xs ${tone}`}>{line.text}</p>
      </div>
      <Tooltip label="Remove source. The people it added stay in the list.">
        <Button variant="ghost" size="icon" onClick={onRemove} aria-label={`Remove ${source.name}`}>
          <X size={16} />
        </Button>
      </Tooltip>
    </div>
  );
}

function capLine(d: Detail): string {
  const { list, cap_from } = d;
  if (cap_from === "list") return `Set here: up to ${list.effective_daily_cap} a day.`;
  if (cap_from === "consumers") return `From the campaigns reading it: ${list.effective_daily_cap} a day.`;
  return "None set, so no emails are looked up on their own. Set a number, or let a campaign read this list.";
}

function memberSource(m: ListMember): string {
  return m.source_kind === "search" ? "Search" : m.source_kind === "signal" ? "Signal" : "By hand";
}

export function ListDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [members, setMembers] = useState<{ members: ListMember[]; total: number; limit: number } | null>(null);
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [cap, setCap] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

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

  async function act(fn: () => Promise<unknown>, success?: string) {
    try {
      await fn();
      if (success) setNotice({ tone: "success", text: success });
      await Promise.all([load(), loadMembers()]);
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    }
  }

  async function saveCap() {
    const v = cap.trim();
    const next = v === "" ? null : Math.max(0, Math.min(1000, Math.round(Number(v))));
    if (v !== "" && !Number.isFinite(Number(v))) {
      setNotice({ tone: "danger", text: "The daily lookups are a number from 0 to 1000, or empty to follow the campaigns." });
      return;
    }
    if (detail && next === detail.list.email_daily_cap) return;
    await act(() => api.updateList(id, { email_daily_cap: next }), "Saved.");
  }

  async function refreshNow() {
    setRefreshing(true);
    await act(async () => {
      const r = await api.refreshList(id);
      const searches = (n: number) => `${n} search${n === 1 ? "" : "es"}`;
      setNotice(
        r.failed > 0
          ? { tone: "danger", text: `Couldn't hand ${searches(r.failed)} to your agent. The reason is under Sources.` }
          : r.started > 0
            ? { tone: "success", text: `Handed ${searches(r.started)} to your agent. New people join as they are found.` }
            : { tone: "success", text: "Nothing to run again: no search source, or each one is still running." },
      );
    });
    setRefreshing(false);
  }

  if (!detail) {
    return (
      <div className="flex min-h-full flex-col">
        <PageHeader title={<Link to="/lists" className="text-muted-foreground hover:text-foreground">Lists</Link>} />
        <div className="px-6 py-6">
          <Notice notice={notice} />
          {notice ? null : <div className="h-40 animate-pulse rounded-md bg-muted" aria-busy="true" />}
        </div>
      </div>
    );
  }

  const { list, sources, consumers } = detail;
  const pages = members ? Math.max(1, Math.ceil(members.total / members.limit)) : 1;

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-1.5">
            <Link to="/lists" className="text-muted-foreground hover:text-foreground">Lists</Link>
            <ChevronRight size={18} className="text-faint" />
            <span className="truncate">{list.name}</span>
          </span>
        }
      >
        <Button onClick={() => void refreshNow()} disabled={refreshing}>
          <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} /> Refresh now
        </Button>
        <Tooltip label="Delete list">
          <Button variant="ghost" size="icon" onClick={() => setDeleting(true)} aria-label="Delete list">
            <Trash2 size={16} />
          </Button>
        </Tooltip>
      </PageHeader>

      <div className="space-y-6 px-6 py-6">
        <Notice notice={notice} />

        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Card>
            <Zone>
              <CardTitle right={<AddSource listId={id} existing={sources} onAdded={(n, searching, contacts) => void act(async () => undefined, addedMessage(n, searching, contacts))} />}>
                Sources
              </CardTitle>
            </Zone>
            {sources.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                No sources yet. Add a search or a signal, and the people it finds join this list.
              </p>
            ) : (
              <div>
                {sources.map((s) => (
                  <SourceRow
                    key={`${s.kind}:${s.source_id}`}
                    source={s}
                    onRemove={() => void act(() => api.removeListSource(id, s.kind, s.source_id), "Removed. The people it added stay.")}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card>
            <Zone>
              <CardTitle>Settings</CardTitle>
            </Zone>
            <Zone>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Run its searches again</div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {list.refresh === "off" ? "Only when you press Refresh now." : `Next ${until(list.next_refresh_at)}. Signals keep their own schedule.`}
                  </p>
                </div>
                <Picker
                  label="Refresh"
                  className="w-48"
                  value={list.refresh}
                  options={REFRESH_OPTIONS}
                  onChange={(v) => void act(() => api.updateList(id, { refresh: v as Refresh }), "Saved.")}
                />
              </div>
            </Zone>
            <Zone>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <label htmlFor="cap" className="text-sm font-medium">Emails looked up a day</label>
                  <p className="mt-0.5 text-xs text-muted-foreground">{capLine(detail)}</p>
                </div>
                <input
                  id="cap"
                  inputMode="numeric"
                  value={cap}
                  onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ""))}
                  onBlur={() => void saveCap()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveCap();
                  }}
                  placeholder="From campaigns"
                  className="input data w-48 text-sm"
                />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                <span className="data">{list.lookups_today}</span> looked up today, emails only, from the cache when it has them. Phones are never bought on their own.
              </p>
            </Zone>
            <Zone>
              <div className="text-sm font-medium">Read by</div>
              {consumers.length === 0 ? (
                <p className="mt-0.5 text-xs text-muted-foreground">No campaign reads this list yet.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {consumers.map((k: ListConsumer) => (
                    <li key={k.key} className="flex items-center justify-between text-sm">
                      <span className="truncate">{k.name}</span>
                      <span className="data text-muted-foreground">{k.daily} a day</span>
                    </li>
                  ))}
                </ul>
              )}
            </Zone>
          </Card>
        </div>
      </div>

      <section className="flex flex-col border-t border-border">
        <div className="flex h-12 items-center gap-3 border-b border-border px-6">
          <h2 className="card-title">People</h2>
          <span className="data text-[0.8125rem] text-muted-foreground">
            {list.member_count.toLocaleString()} · {list.verified_count.toLocaleString()} with a verified email
          </span>
        </div>
        {members && members.members.length === 0 ? (
          <Empty title="Nobody here yet" hint="People join as its searches and signals find them, or add them from Leads." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={`${TH} pl-6`}>Name</th>
                  <th className={TH}>Company</th>
                  <th className={TH}>Email</th>
                  <th className={TH}>Status</th>
                  <th className={`${TH} pr-6`}>Joined</th>
                </tr>
              </thead>
              <tbody>
                {(members?.members ?? []).map((m) => (
                  <tr key={m.id} className="h-11 border-b border-border hover:bg-muted">
                    <td className="px-4 py-2 pl-6">
                      <div className="font-medium">{m.full_name || (isInbox(m.email) ? <span className="text-muted-foreground">Company inbox</span> : <span className="text-faint">Unnamed</span>)}</div>
                      {m.title ? <div className="text-xs text-muted-foreground">{m.title}</div> : null}
                    </td>
                    <td className="px-4 py-2">
                      <div>{m.company || <span className="text-faint">Unknown</span>}</div>
                      {m.domain ? <div className="text-xs text-muted-foreground">{m.domain}</div> : null}
                    </td>
                    <td className="px-4 py-2">
                      {m.email ? (
                        <span className="flex items-center gap-1.5">
                          <a href={`mailto:${m.email}`} className="text-info hover:underline">{m.email}</a>
                          {m.email_verified ? null : <Chip>unverified</Chip>}
                        </span>
                      ) : (
                        <span className="text-faint">None yet</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge lead={m} />
                    </td>
                    <td className="px-4 py-2 pr-6 text-muted-foreground">
                      {ago(m.added_at)} <span className="text-faint">· {memberSource(m)}</span>
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
        description="The list and its settings go. The people stay in Leads, and campaigns reading it stop getting new people."
        submitLabel="Delete list"
        danger
        onSubmit={() =>
          void (async () => {
            try {
              await api.deleteList(id);
              navigate("/lists");
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
