// Waterfall configuration. Set once, then almost never touched — so it lives
// behind its own route rather than occupying the working surface.

import { Link } from "react-router-dom";
import { ArrowLeft, CircleAlert, Database } from "lucide-react";
import { Badge, Card, Chip, Eyebrow, Favicon, Zone } from "../components/ui";
import { WaterfallCard } from "../components/waterfall";
import type { Provider } from "../api";

const FIELDS = ["email", "phone"];

export function Settings({
  providers,
  waterfalls,
  cacheDays,
  onReorder,
}: {
  providers: Provider[];
  waterfalls: Record<string, string[]>;
  cacheDays: number;
  onReorder: (field: string, order: string[]) => void;
}) {
  const missing = providers.filter((p) => !p.configured);

  return (
    <>
      <div className="mb-6">
        <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground">
          <ArrowLeft size={13} /> Back to leads
        </Link>
        <h1 className="mt-2 text-xl font-bold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-sm text-muted">
          Provider keys and waterfall order. Configure once — enrichment uses this on every run.
        </p>
      </div>

      <Card className="mb-6">
        <Zone>
          <Eyebrow right={`${providers.length - missing.length}/${providers.length} configured`}>Provider keys</Eyebrow>
          <p className="mt-1.5 text-xs text-muted">
            Keys are read from the platform's secret store, never held by this app. Every provider is optional — the
            waterfall skips any vendor without a key and records it in the attempt log, so gaps are visible rather than
            silent.
          </p>
        </Zone>
        {providers.map((p) => (
          <div key={p.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
            <Favicon domain={p.signup_url} size={14} />
            <span className="flex-1 text-sm font-medium">{p.label}</span>
            <Chip>{p.secret_name}</Chip>
            {p.configured ? (
              typeof p.credits_remaining === "number" ? (
                <Badge tone="success">
                  <span className="data">{p.credits_remaining.toLocaleString()}</span> credits
                </Badge>
              ) : (
                <Badge tone="success">Configured</Badge>
              )
            ) : (
              <a href={p.signup_url} target="_blank" rel="noreferrer">
                <Badge tone="warning">
                  <CircleAlert size={11} /> Get a key
                </Badge>
              </a>
            )}
          </div>
        ))}
        <Zone className="bg-sunken/50">
          <Eyebrow>Cache</Eyebrow>
          <p className="mt-1.5 text-xs text-muted">
            Resolved contacts are reused for{" "}
            <span className="data font-medium text-foreground">{cacheDays} days</span>, so the same person is never
            bought twice. Contact data decays as people change jobs, which is why the cache expires rather than growing
            forever.
          </p>
          <span className="mt-2 inline-flex">
            <Chip>
              <Database size={11} /> {cacheDays}-day reuse window
            </Chip>
          </span>
        </Zone>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {FIELDS.map((f) => (
          <WaterfallCard
            key={f}
            field={f}
            order={waterfalls[f] ?? []}
            providers={providers}
            onReorder={(next) => onReorder(f, next)}
          />
        ))}
      </div>
    </>
  );
}
