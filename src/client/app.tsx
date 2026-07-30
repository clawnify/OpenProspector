import { useCallback, useEffect, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { ArrowUp, Check, Copy, Settings as SettingsIcon, Upload } from "lucide-react";
import { api, type Lead, type Provider, type Run } from "./api";
import { Badge, Button, Card, Eyebrow, Zone } from "./components/ui";
import { LeadsTable } from "./components/leads-table";
import { RunsPanel } from "./components/runs-panel";
import { Settings } from "./routes/settings";

/** Parse a pasted CSV into lead rows. Header names are matched loosely so a
 *  file exported from any CRM lands without the user renaming columns. */
function parseCsv(text: string): Partial<Lead>[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const split = (l: string) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const headers = split(lines[0]).map((h) => h.toLowerCase());
  const pick = (row: string[], ...names: string[]) => {
    for (const n of names) {
      const i = headers.findIndex((h) => h === n || h.replace(/[ _]/g, "") === n.replace(/[ _]/g, ""));
      if (i >= 0 && row[i]) return row[i];
    }
    return "";
  };
  return lines.slice(1).map((line) => {
    const row = split(line);
    const first = pick(row, "first name", "firstname");
    const last = pick(row, "last name", "lastname");
    return {
      full_name: pick(row, "full name", "fullname", "name") || [first, last].filter(Boolean).join(" "),
      title: pick(row, "title", "job title", "position"),
      company: pick(row, "company", "organization", "account"),
      domain: pick(row, "domain", "website", "company domain", "url"),
      linkedin_url: pick(row, "linkedin", "linkedin url"),
      source: "csv",
    };
  });
}

export function App() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [waterfalls, setWaterfalls] = useState<Record<string, string[]>>({});
  const [cacheDays, setCacheDays] = useState(90);

  const [runs, setRuns] = useState<Run[]>([]);
  const [runFilter, setRunFilter] = useState<string | null>(null);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [search, setSearch] = useState("");

  const [icp, setIcp] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [handoff, setHandoff] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadProviders = useCallback(async () => {
    try {
      const p = await api.providers(true);
      setProviders(p.providers);
      setWaterfalls(p.waterfalls);
      setCacheDays(p.cache_max_age_days);
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      setRuns((await api.runs()).runs);
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    }
  }, []);

  const loadLeads = useCallback(async () => {
    try {
      const r = await api.leads({ page, search, run_id: runFilter ?? undefined });
      setLeads(r.leads);
      setTotal(r.total);
      setLimit(r.limit);
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    }
  }, [page, search, runFilter]);

  useEffect(() => {
    void loadProviders();
    void loadRuns();
  }, [loadProviders, loadRuns]);

  // Poll only while the agent is actually working. A run that is done, failed or
  // stalled will not change on its own, so polling then is pure noise — and this
  // app is embedded in a dashboard iframe that may sit open all day.
  const hasLiveRun = runs.some((r) => !r.stale && (r.status === "sourcing" || r.status === "enriching"));
  useEffect(() => {
    if (!hasLiveRun) return;
    const t = setInterval(() => {
      void loadRuns();
      void loadLeads();
    }, 10_000);
    return () => clearInterval(t);
  }, [hasLiveRun, loadRuns, loadLeads]);

  // Debounced so typing in the search box doesn't hammer the API.
  useEffect(() => {
    const t = setTimeout(() => void loadLeads(), 200);
    return () => clearTimeout(t);
  }, [loadLeads]);

  async function reorder(field: string, order: string[]) {
    setWaterfalls((w) => ({ ...w, [field]: order })); // optimistic
    try {
      await api.setWaterfall(field, order);
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
      void loadProviders();
    }
  }

  async function enrich(id: string, refresh: boolean) {
    setBusyId(id);
    try {
      const r = await api.enrichLead(id, refresh);
      setNotice({
        tone: "success",
        text: r.cached
          ? "Resolved from cache — no credits spent."
          : `Enriched. ${r.credits_used} credit${r.credits_used === 1 ? "" : "s"} spent.`,
      });
      await Promise.all([loadLeads(), loadProviders()]);
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Sourcing runs on the org's agent, not in this app: it needs a real browser,
   * live sessions, and minutes of runtime. So the run is created here and the
   * work is handed over as an instruction rather than pretended to be started.
   */
  function handoffBrief(runId: string, prompt: string) {
    return [
      `Find leads matching this ICP and add them to Open Prospector:`,
      ``,
      `"${prompt}"`,
      ``,
      `Research the live web — maps and review sites for local businesses, job`,
      `boards for hiring signals, funding news and company blogs for growth`,
      `signals, professional profiles for the people themselves.`,
      ``,
      `For every lead include full_name, company, and the bare domain, plus`,
      `evidence (one line on why they qualify) and source_url.`,
      ``,
      `Then POST them to /api/leads with run_id "${runId}".`,
    ].join("\n");
  }

  async function startRun() {
    if (icp.trim().length < 3) return;
    try {
      const { run } = await api.createRun(icp.trim());
      setHandoff(handoffBrief(run.id, run.icp_prompt));
      setIcp("");
      await Promise.all([loadRuns(), loadLeads()]);
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    }
  }

  async function onCsv(file: File) {
    try {
      const rows = parseCsv(await file.text());
      if (rows.length === 0) throw new Error("No rows found — the file needs a header row and at least one lead.");
      const r = await api.importLeads(rows);
      setNotice({ tone: "success", text: `Imported ${r.imported} lead${r.imported === 1 ? "" : "s"}.` });
      setPage(1);
      await loadLeads();
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    }
  }

  const configured = providers.filter((p) => p.configured).length;
  const unconfigured = providers.length - configured;

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <Routes>
        <Route
          path="/settings"
          element={
            <Settings
              providers={providers}
              waterfalls={waterfalls}
              cacheDays={cacheDays}
              onReorder={(f, o) => void reorder(f, o)}
            />
          }
        />
        <Route
          path="*"
          element={
            <>
              <header className="mb-7 flex items-end justify-between gap-4">
                <div>
                  <h1 className="text-xl font-bold tracking-tight">Open Prospector</h1>
                  <p className="mt-0.5 text-sm text-muted">
                    Find and enrich leads with your own provider keys — at cost, with no per-lead markup.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {/* Only surfaced when something needs attention — a fully
                      configured setup shouldn't nag on every page load. */}
                  {unconfigured > 0 ? (
                    <Link to="/settings">
                      <Badge tone="warning">
                        {unconfigured} provider{unconfigured === 1 ? "" : "s"} without a key
                      </Badge>
                    </Link>
                  ) : null}
                  <Link to="/settings">
                    <Button>
                      <SettingsIcon size={13} /> Settings
                    </Button>
                  </Link>
                </div>
              </header>

              {notice ? (
                <div
                  className={`mb-5 rounded-md border px-3 py-2 text-sm ${
                    notice.tone === "success"
                      ? "border-success/25 bg-success-tint text-success"
                      : "border-danger/25 bg-danger-tint text-danger"
                  }`}
                  role="status"
                >
                  {notice.text}
                </div>
              ) : null}

              <Card className="mb-6">
                <Zone>
                  <Eyebrow>Ideal customer profile</Eyebrow>
                  <textarea
                    value={icp}
                    onChange={(e) => setIcp(e.target.value)}
                    rows={2}
                    placeholder="Find personal financial advisory firms that just hired a compliance officer…"
                    className="mt-2 w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm placeholder:text-faint"
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted hover:text-foreground">
                      <Upload size={13} />
                      Import CSV
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void onCsv(f);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    {/* The single coral action on this screen. */}
                    <Button variant="primary" onClick={startRun} disabled={icp.trim().length < 3}>
                      Start search <ArrowUp size={13} />
                    </Button>
                  </div>
                </Zone>
              </Card>

              {handoff ? (
                <Card className="mb-6">
                  <Zone>
                    <Eyebrow right="sourcing runs on your agent, not in this app">Hand off to your agent</Eyebrow>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-sunken px-3 py-2 text-xs leading-relaxed text-muted">
                      {handoff}
                    </pre>
                    <div className="mt-2 flex items-center gap-2">
                      <Button
                        onClick={() => {
                          void navigator.clipboard.writeText(handoff).then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          });
                        }}
                      >
                        {copied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} />}
                        {copied ? "Copied" : "Copy brief"}
                      </Button>
                      <Button variant="ghost" onClick={() => setHandoff(null)}>
                        Dismiss
                      </Button>
                    </div>
                  </Zone>
                </Card>
              ) : null}

              <RunsPanel
                runs={runs}
                activeRunId={runFilter}
                onFilterRun={(id) => {
                  setRunFilter(id);
                  setPage(1);
                }}
              />

              <LeadsTable
                leads={leads}
                providers={providers}
                total={total}
                page={page}
                limit={limit}
                search={search}
                busyId={busyId}
                onSearch={(v) => {
                  setSearch(v);
                  setPage(1);
                }}
                onPage={setPage}
                onEnrich={(id, refresh) => void enrich(id, refresh)}
              />
            </>
          }
        />
      </Routes>
    </div>
  );
}
