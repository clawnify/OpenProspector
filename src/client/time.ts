// Times as the screens say them. The server stores SQLite's "YYYY-MM-DD
// HH:MM:SS" (UTC) in some columns and ISO strings in others; both read here.

/** SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) or an ISO string, as a Date. */
export function parse(at: string): Date {
  return new Date(at.includes("T") ? at : `${at.replace(" ", "T")}Z`);
}

export function ago(at: string | null): string {
  if (!at) return "never";
  const s = Math.round((Date.now() - parse(at).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return parse(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function until(at: string | null): string {
  if (!at) return "not scheduled";
  const s = Math.round((parse(at).getTime() - Date.now()) / 1000);
  if (s <= 60) return "in a moment";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return parse(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
