// The shared vocabulary, shaped by the platform DESIGN.md: chips are facts,
// badges are signals — two deliberately different shapes so a glance tells
// you which you're reading.

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

/** Card title row (DESIGN.md → Signature 3): 17px/600 sentence case, an optional meta value at the right. */
export function CardTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="card-title">{children}</h2>
      {right ? <span className="text-[0.8125rem] text-muted-foreground data">{right}</span> : null}
    </div>
  );
}

/** A card is anatomy, not a padded box: stacked zones split by hairlines. Its edge is the inset ring. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function Zone({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`border-b border-border p-4 last:rounded-b-md last:border-b-0 ${className}`}>{children}</div>;
}

/** Enumerable fact — provider name, source, field type. Quiet by design. */
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-xs bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
      {children}
    </span>
  );
}

type Tone = "success" | "warning" | "danger" | "neutral";

const TONES: Record<Tone, string> = {
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
  danger: "bg-destructive-tint text-destructive",
  neutral: "bg-muted text-muted-foreground",
};

/** Status that wants attention: a tinted pill, text in the same hue, no outline. */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

/**
 * 28px, 8px radius, 14px/500. Primary is solid ink (one per screen); secondary
 * is white with the raised ring; ghost is for cancel and row controls. `icon`
 * is a 28px square for a lone glyph — never for a primary action.
 */
export function Button({
  children,
  onClick,
  variant = "secondary",
  size = "default",
  disabled,
  type = "button",
  title,
  className = "",
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  size?: "default" | "icon";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const base =
    "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50";
  const sizes = { default: "px-2.5", icon: "w-7 px-0" };
  const variants = {
    primary: "bg-primary text-primary-foreground hover:bg-primary-hover shadow-solid",
    secondary: "bg-card text-foreground hover:bg-muted shadow-raised",
    ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Never inside a card: one line, a hint, generous whitespace. */
export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="mt-1 text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
