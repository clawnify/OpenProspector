// The waterfall panel: an ordered list per field, mirroring exactly what the
// runner will do at enrichment time. Order is the user's lever on cost — cheap
// providers first, expensive fallbacks last — so it is directly editable here.

import { ArrowDown, ArrowUp, Check, CircleAlert, Mail, Phone } from "lucide-react";
import { Badge, Card, Chip, Empty, Eyebrow, Favicon, Zone } from "./ui";
import type { Provider } from "../api";

const FIELD_META: Record<string, { label: string; icon: typeof Mail; note: string }> = {
  email: {
    label: "Email waterfall",
    icon: Mail,
    note: "First verified result wins. Unverified values never stop the search.",
  },
  phone: {
    label: "Phone waterfall",
    icon: Phone,
    note: "Mobile and work numbers, validated before delivery.",
  },
};

export function WaterfallCard({
  field,
  order,
  providers,
  onReorder,
}: {
  field: string;
  order: string[];
  providers: Provider[];
  onReorder: (next: string[]) => void;
}) {
  const meta = FIELD_META[field];
  const Icon = meta.icon;
  const byId = new Map(providers.map((p) => [p.id, p]));

  function move(i: number, dir: -1 | 1) {
    const next = [...order];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onReorder(next);
  }

  return (
    <Card>
      <Zone>
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-sunken">
            <Icon size={14} className="text-muted" />
          </span>
          <h2 className="text-base font-semibold">{meta.label}</h2>
          <span className="ml-auto text-[0.6875rem] text-faint data">
            {order.length} {order.length === 1 ? "provider" : "providers"}
          </span>
        </div>
      </Zone>

      {order.length === 0 ? (
        <Empty title={`No providers can resolve ${field} yet`} hint="Add an adapter to the registry to enable this waterfall." />
      ) : (
        <div>
          {order.map((id, i) => {
            const p = byId.get(id);
            if (!p) return null;
            return (
              <div
                key={id}
                className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 hover:bg-sunken/60"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-[0.6875rem] text-muted data">
                  {i + 1}
                </span>
                <Favicon domain={p.signup_url} size={14} />
                <span className="flex-1 truncate text-sm font-medium">{p.label}</span>
                {p.deferred?.includes(field) ? (
                  // The one vendor kind that changes how a run feels: a lead
                  // that reaches it waits for the answer instead of moving on.
                  <span title="Answers by callback — a lead pauses here until the vendor replies">
                    <Chip>Callback</Chip>
                  </span>
                ) : null}

                {p.status === "planned" ? (
                  // Shown in position so the intended depth of the waterfall is
                  // visible, but badged: the runner resolves ids against the
                  // registry, so this vendor is never actually called.
                  <Badge tone="warning">Planned</Badge>
                ) : p.configured ? (
                  typeof p.credits_remaining === "number" ? (
                    <Chip>
                      <span className="data">{p.credits_remaining.toLocaleString()}</span> credits
                    </Chip>
                  ) : null
                ) : (
                  // Surfaced, not hidden: an unconfigured vendor is the most
                  // common reason coverage looks worse than expected.
                  <a href={p.signup_url} target="_blank" rel="noreferrer" title={`Set ${p.secret_name}`}>
                    <Badge tone="warning">
                      <CircleAlert size={11} /> No key
                    </Badge>
                  </a>
                )}

                <span className="flex shrink-0 gap-0.5">
                  <button
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    aria-label={`Move ${p.label} up`}
                    className="rounded-sm p-1 text-faint hover:bg-sunken hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={i === order.length - 1}
                    aria-label={`Move ${p.label} down`}
                    className="rounded-sm p-1 text-faint hover:bg-sunken hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                  >
                    <ArrowDown size={13} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <Zone className="bg-sunken/50">
        <Eyebrow>How this runs</Eyebrow>
        <p className="mt-1.5 text-xs text-muted">{meta.note}</p>
        <span className="mt-2 inline-flex">
          <Badge tone="success">
            <Check size={11} strokeWidth={2.5} /> Verified before delivery
          </Badge>
        </span>
      </Zone>
    </Card>
  );
}
