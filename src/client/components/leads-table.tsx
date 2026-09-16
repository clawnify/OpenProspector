// The leads table. Every enriched cell carries its provider attribution, so
// "where did this email come from?" is answerable without opening anything.

import { useEffect, useRef, useState } from "react";
import { Activity, Building2, Check, ChevronDown, Clock, Download, Loader2, Mail, RefreshCw, Search, User } from "lucide-react";
import { Badge, Button, Chip, Empty, Favicon } from "./ui";
import type { Lead, Provider } from "../api";

function StatusBadge({ lead }: { lead: Lead }) {
  if (lead.enrich_status === "running") {
    return (
      <Badge tone="neutral">
        <Loader2 size={11} className="animate-spin" /> Enriching
      </Badge>
    );
  }
  if (lead.enrich_status === "waiting") {
    // Parked on a vendor that answers by callback. Not "running": nothing is
    // happening on our side, and the wait is bounded by the callback timeout.
    return (
      <Badge tone="neutral">
        <Clock size={11} /> Awaiting callback
      </Badge>
    );
  }
  if (lead.enrich_status === "failed") return <Badge tone="danger">Failed</Badge>;
  if (lead.enrich_status === "pending") return <Badge tone="neutral">Pending</Badge>;
  // "done" splits by outcome — a finished lead with nothing found is not a success.
  return lead.email ? (
    <Badge tone="success">
      <Check size={11} strokeWidth={2.5} /> Found
    </Badge>
  ) : (
    <Badge tone="warning">No match</Badge>
  );
}

/**
 * The export formats, in the order they are offered.
 *
 * The LinkedIn shapes are not a different view of the same file: each emits the
 * exact header row Campaign Manager's importer expects, and Campaign Manager
 * rejects the upload outright if the headers do not match. That contract lives
 * server-side in export.ts — this menu only names the formats, so the two can
 * never drift into two different opinions about the columns.
 */
const EXPORT_FORMATS = [
  {
    format: "leads",
    label: "Full lead records",
    hint: "Every column, including provider attribution and cost",
  },
  {
    format: "linkedin-contacts",
    label: "LinkedIn contact audience",
    hint: "Matched on email; leads without one are left out",
  },
  {
    format: "linkedin-companies",
    label: "LinkedIn company audience",
    hint: "One row per company, deduplicated across all pages",
  },
] as const;

/**
 * Export as a menu rather than a single button.
 *
 * The LinkedIn formats have been served by the API since it shipped, but the
 * only way to reach them was to hand-edit the download URL — so in practice the
 * feature did not exist for anyone using the app. A picker is the whole fix.
 */
function ExportMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const href = (format: string) => `/api/export/leads.csv?format=${format}`;

  return (
    <div className="relative" ref={ref}>
      <Button onClick={() => setOpen((v) => !v)} aria-label="Export CSV">
        <Download size={16} /> Export CSV
        <ChevronDown size={16} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-72 overflow-hidden rounded-md bg-card p-1 shadow-float"
        >
          {EXPORT_FORMATS.map((f) => (
            <a
              key={f.format}
              role="menuitem"
              href={href(f.format)}
              download
              onClick={() => setOpen(false)}
              className="block rounded-sm px-3 py-2 hover:bg-muted"
            >
              <span className="block text-sm text-foreground">{f.label}</span>
              <span className="block text-xs text-muted-foreground">{f.hint}</span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const TH = "h-10 px-4 text-left text-[0.8125rem] font-medium text-muted-foreground";

export function LeadsTable({
  leads,
  providers,
  total,
  page,
  limit,
  search,
  busyId,
  onSearch,
  onPage,
  onEnrich,
}: {
  leads: Lead[];
  providers: Provider[];
  total: number;
  page: number;
  limit: number;
  search: string;
  busyId: string | null;
  onSearch: (v: string) => void;
  onPage: (p: number) => void;
  onEnrich: (id: string, refresh: boolean) => void;
}) {
  // Provider id -> signup host, so an attribution chip can show the vendor mark.
  const domainById = new Map(providers.map((p) => [p.id, p.signup_url]));
  const pages = Math.max(1, Math.ceil(total / limit));
  const found = leads.filter((l) => l.email).length;

  // The primary table runs directly on the white pane, edge to edge, with the
  // filter bar above it (DESIGN.md → Table pages). No card, no outer frame.
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-6">
        <div className="relative w-80">
          <Search size={16} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search name, company, domain, title…"
            className="input pl-8 text-sm"
          />
        </div>
        <span className="text-[0.8125rem] text-muted-foreground data">{total.toLocaleString()} leads</span>
        <span className="flex-1" />
        <ExportMenu />
      </div>

      {leads.length === 0 ? (
        <Empty title="No leads yet" hint="Describe an ideal customer above, or import a CSV to enrich a list you already have." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={`${TH} pl-6`}><span className="inline-flex items-center gap-1.5"><User size={14} /> Name</span></th>
                <th className={TH}><span className="inline-flex items-center gap-1.5"><Building2 size={14} /> Company</span></th>
                <th className={TH}><span className="inline-flex items-center gap-1.5"><Mail size={14} /> Email</span></th>
                <th className={TH}><span className="inline-flex items-center gap-1.5"><Activity size={14} /> Status</span></th>
                <th className={`${TH} w-14 pr-6`} />
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="h-11 border-b border-border hover:bg-muted">
                  <td className="px-4 py-2 pl-6">
                    <div className="font-medium">{l.full_name || <span className="text-faint">—</span>}</div>
                    {l.title ? <div className="text-xs text-muted-foreground">{l.title}</div> : null}
                  </td>
                  <td className="px-4 py-2">
                    <div>{l.company || <span className="text-faint">—</span>}</div>
                    {l.domain ? <div className="text-xs text-muted-foreground">{l.domain}</div> : null}
                  </td>
                  <td className="px-4 py-2">
                    {l.email ? (
                      <div className="flex flex-col items-start gap-1">
                        <a href={`mailto:${l.email}`} className="text-info hover:underline">
                          {l.email}
                        </a>
                        {/* Attribution on the cell itself — the waterfall is
                            only trustworthy if you can see who answered. */}
                        {l.email_provider ? (
                          <Chip>
                            <Favicon domain={domainById.get(l.email_provider)} />
                            via {l.email_provider}
                          </Chip>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge lead={l} />
                  </td>
                  <td className="px-4 py-2 pr-6 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onEnrich(l.id, Boolean(l.email))}
                      disabled={busyId === l.id}
                      title={l.email ? "Re-buy from vendors (costs credits)" : "Enrich (uses cache when possible)"}
                      aria-label={l.email ? "Re-enrich" : "Enrich"}
                    >
                      <RefreshCw size={16} className={busyId === l.id ? "animate-spin" : ""} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex h-10 items-center justify-between px-6 text-xs text-muted-foreground">
            <span>
              <span className="data">{found}</span> of <span className="data">{leads.length}</span> on this page have an email
            </span>
            {pages > 1 ? (
              <span className="flex items-center gap-3">
                <span>
                  Page <span className="data">{page}</span> of <span className="data">{pages}</span>
                </span>
                <span className="flex gap-1.5">
                  <Button onClick={() => onPage(page - 1)} disabled={page <= 1}>
                    Previous
                  </Button>
                  <Button onClick={() => onPage(page + 1)} disabled={page >= pages}>
                    Next
                  </Button>
                </span>
              </span>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
