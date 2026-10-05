// The shared vocabulary, shaped by the platform DESIGN.md: chips are facts,
// badges are signals — two deliberately different shapes so a glance tells
// you which you're reading.

import { useState, type ComponentProps, type FormEvent, type ReactElement, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Command } from "cmdk";
import { ChevronDown } from "lucide-react";

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
 * is white with the raised ring; ghost is for cancel and row controls; danger
 * is the tint that fills solid on hover. `icon`
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
  variant?: "primary" | "secondary" | "ghost" | "danger";
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
    danger: "bg-destructive-tint text-destructive hover:bg-destructive-solid hover:text-primary-foreground",
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

/**
 * Radix handles placement, focus, Escape and outside click; the surface is the
 * same card-and-float as the other menus. Rendered in a portal, so a popover
 * opened from a row is never clipped by the table's scroll container.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({
  className = "",
  align = "start",
  sideOffset = 4,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={`z-50 rounded-md bg-card p-1 text-foreground shadow-float outline-none ${className}`}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

/**
 * What an icon-only control does, on hover and on keyboard focus. The house
 * shadcn tooltip, ink on white with an arrow, rendered in a portal so a row's
 * tooltip is never clipped by the table. It brings its own provider, so nothing
 * has to wrap the app. The child must pass its props and ref on to a real
 * element, as Button does, and a disabled button shows no tooltip.
 */
export function Tooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <TooltipPrimitive.Provider delayDuration={0}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={4}
            className="z-50 w-fit max-w-64 rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background"
          >
            {label}
            <TooltipPrimitive.Arrow className="fill-foreground" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export interface PickerOption {
  value: string;
  label: string;
  /** A quiet note at the right of the option, such as a status. */
  hint?: string;
}

/**
 * The house combobox (DESIGN.md: Selects): a Popover holding a Command list,
 * never a native <select>. `field` sets a value in a form and takes the input
 * shape; `view` changes what the page shows and takes the raised 28px
 * trigger. The chosen option is a highlight, not a tick, and a search joins
 * once the list passes ten options.
 */
export function Picker({
  value,
  options,
  onChange,
  label,
  placeholder = "Choose",
  kind = "field",
  disabled,
  className = "",
  empty = "Nothing to choose from yet",
}: {
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  kind?: "field" | "view";
  disabled?: boolean;
  className?: string;
  empty?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  const trigger =
    kind === "field"
      ? "input flex items-center justify-between gap-2 text-left text-sm disabled:opacity-50"
      : "inline-flex h-7 items-center gap-1.5 rounded-sm bg-card px-2.5 text-sm font-medium shadow-raised hover:bg-muted data-[state=open]:bg-muted disabled:opacity-50";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" aria-label={label} className={`${trigger} ${className}`}>
          <span className={`min-w-0 truncate ${current ? "" : "text-muted-foreground"}`}>{current?.label ?? placeholder}</span>
          <ChevronDown size={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-56">
        {/* The keyboard cursor starts on the chosen row, so one row is lit on
            open rather than the first row and the chosen one together. */}
        <Command label={label} defaultValue={current ? `${current.label} ${current.value}`.trim() : undefined}>
          {options.length > 10 ? <Command.Input placeholder="Search" className="input mb-1 h-8 text-sm" /> : null}
          <Command.List className="max-h-64 overflow-y-auto">
            <Command.Empty className="px-2 py-1.5 text-sm text-muted-foreground">{options.length ? "No match" : empty}</Command.Empty>
            {options.map((o) => (
              <Command.Item
                key={o.value}
                value={`${o.label} ${o.value}`}
                onSelect={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                data-chosen={o.value === value || undefined}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-muted data-[chosen]:bg-muted data-[chosen]:font-medium"
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint ? <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span> : null}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The shadcn Dialog composition (DESIGN.md: Dialogs). The overlay is the
 * scroll container, so a tall form starts at the top and scrolls to its
 * footer. Always a form with a ghost Cancel and one primary submit.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  submitting,
  danger,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  submitLabel: string;
  submitting?: boolean;
  danger?: boolean;
  onSubmit: () => void;
  children?: ReactNode;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 overflow-y-auto bg-foreground/30">
          <div className="flex min-h-full items-center justify-center p-4">
            <DialogPrimitive.Content className="w-full max-w-sm rounded-lg bg-card p-5 shadow-float outline-none">
              <form onSubmit={submit}>
                <DialogPrimitive.Title className="card-title">{title}</DialogPrimitive.Title>
                {description ? (
                  <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>
                ) : (
                  <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
                )}
                {children ? <div className="mt-4 space-y-3">{children}</div> : null}
                <div className="mt-5 flex justify-end gap-2">
                  <DialogPrimitive.Close asChild>
                    <Button variant="ghost">Cancel</Button>
                  </DialogPrimitive.Close>
                  <Button type="submit" variant={danger ? "danger" : "primary"} disabled={submitting}>
                    {submitLabel}
                  </Button>
                </div>
              </form>
            </DialogPrimitive.Content>
          </div>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

