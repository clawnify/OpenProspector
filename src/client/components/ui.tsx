// The shared vocabulary. Chips are facts; badges are signals — the two are
// deliberately different shapes so a glance tells you which you're reading.

import { useState, type ReactNode } from "react";

/**
 * Vendor favicon. Points at gstatic's faviconV2 directly rather than
 * `google.com/s2/favicons`, which is just a 301 onto this same endpoint — going
 * direct saves every icon a redirect hop.
 *
 * Renders nothing if the icon fails to load: the adjacent label already carries
 * the meaning, so a broken-image box would be pure noise.
 */
export function Favicon({ domain, size = 12 }: { domain?: string | null; size?: number }) {
  const [err, setErr] = useState(false);
  // Tolerate a full URL ("https://app.acme.com/keys"); the service wants a host.
  const host = (domain || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./i, "");
  if (!host || err) return null;
  const src =
    "https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=64" +
    `&url=${encodeURIComponent(`https://${host}`)}`;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="shrink-0 rounded-[2px]"
      onError={() => setErr(true)}
    />
  );
}

export function Eyebrow({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="eyebrow">{children}</span>
      {right ? <span className="text-[0.6875rem] text-faint data">{right}</span> : null}
    </div>
  );
}

/** A card is anatomy, not a padded box: stacked zones split by hairlines. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-border bg-surface ${className}`}>{children}</div>
  );
}

export function Zone({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`border-b border-border p-4 last:border-b-0 ${className}`}>{children}</div>;
}

/** Enumerable fact — provider name, source, field type. Quiet by design. */
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-border bg-sunken px-1.5 py-0.5 text-[0.6875rem] text-muted">
      {children}
    </span>
  );
}

type Tone = "success" | "warning" | "danger" | "neutral";

const TONES: Record<Tone, string> = {
  success: "bg-success-tint text-success border-success/25",
  warning: "bg-warning-tint text-warning border-warning/25",
  danger: "bg-danger-tint text-danger border-danger/25",
  neutral: "bg-sunken text-muted border-border",
};

/** Status that wants attention. Pill-shaped, normal weight — quiet, not bold. */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-normal ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none";
  const variants = {
    // Darkens on hover, never lightens. Exactly one of these per screen.
    primary: "bg-primary text-on-primary hover:bg-primary-hover",
    secondary: "border border-border bg-surface text-foreground hover:bg-sunken",
    ghost: "text-muted hover:bg-sunken hover:text-foreground",
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`${base} ${variants[variant]}`}>
      {children}
    </button>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm text-muted">{title}</p>
      {hint ? <p className="mt-1 text-xs text-faint">{hint}</p> : null}
    </div>
  );
}
