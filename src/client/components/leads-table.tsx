// The leads table. Every enriched cell carries its provider attribution, so
// "where did this email come from?" is answerable without opening anything.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Clock, Download, Loader2, RefreshCw, Search } from "lucide-react";
import { Badge, Button, Card, Chip, Empty, Eyebrow, Favicon, Zone } from "./ui";
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
      <Button onClick={() => setOpen((v) => !v)}>
        <Download size={13} /> Export CSV
        <ChevronDown size={13} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-72 overflow-hidden rounded-md border border-border bg-surface shadow-lg"
        >
          {EXPORT_FORMATS.map((f) => (
            <a
              key={f.format}
              role="menuitem"
              href={href(f.format)}
              download
              onClick={() => setOpen(false)}
              className="block border-b border-border px-3 py-2 last:border-b-0 hover:bg-sunken"
            >
              <span className="block text-sm text-foreground">{f.label}</span>
              <span className="block text-xs text-faint">{f.hint}</span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

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

  return (
    <Card>
      <Zone>
        <Eyebrow right={`${total.toLocaleString()} total`}>Leads</Eyebrow>
        <div className="mt-2 flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search name, company, domain, title…"
              className="w-full rounded-md border border-border bg-surface py-1.5 pl-8 pr-3 text-sm placeholder:text-faint"
            />
          </div>
          <ExportMenu />
        </div>
      </Zone>

      {leads.length === 0 ? (
        <Empty title="No leads yet" hint="Describe an ideal customer above, or import a CSV to enrich a list you already have." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-sunken/60 text-left">
                <th className="px-4 py-2 font-medium text-muted">Name</th>
                <th className="px-4 py-2 font-medium text-muted">Company</th>
                <th className="px-4 py-2 font-medium text-muted">Email</th>
                <th className="px-4 py-2 font-medium text-muted">Status</th>
                <th className="w-10 px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-b border-border last:border-b-0 hover:bg-sunken/40">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{l.full_name || <span className="text-faint">—</span>}</div>
                    {l.title ? <div className="text-xs text-faint">{l.title}</div> : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <div>{l.company || <span className="text-faint">—</span>}</div>
                    {l.domain ? <div className="text-xs text-faint">{l.domain}</div> : null}
                  </td>
                  <td className="px-4 py-2.5">
                    {l.email ? (
                      <div className="flex flex-col items-start gap-1">
                        <a href={`mailto:${l.email}`} className="text-link hover:underline">
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
                  <td className="px-4 py-2.5">
                    <StatusBadge lead={l} />
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => onEnrich(l.id, Boolean(l.email))}
                      disabled={busyId === l.id}
                      title={l.email ? "Re-buy from vendors (costs credits)" : "Enrich (uses cache when possible)"}
                      className="rounded-sm p-1 text-faint hover:bg-sunken hover:text-foreground disabled:opacity-40"
                    >
                      <RefreshCw size={13} className={busyId === l.id ? "animate-spin" : ""} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-sunken/60">
                <td colSpan={5} className="px-4 py-2 text-xs text-muted">
                  <span className="data">{found}</span> of <span className="data">{leads.length}</span> on this page have an
                  email
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {pages > 1 ? (
        <Zone className="flex items-center justify-between">
          <span className="text-xs text-muted">
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
        </Zone>
      ) : null}
    </Card>
  );
}
