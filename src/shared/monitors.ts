import { z } from "zod";

export const MONITOR_TEMPLATES = [
  { id: "own", title: "My LinkedIn posts", description: "Find relevant people engaging with your recent and new posts.", label: "Your LinkedIn profile URL", placeholder: "https://www.linkedin.com/in/your-profile" },
  { id: "team", title: "Team posts", description: "Follow engagement on posts from selected employees.", label: "Employee profile URLs (one per line, up to 10)", placeholder: "https://www.linkedin.com/in/colleague" },
  { id: "post", title: "Specific post", description: "Keep checking one post for new comments, mentions and reactions.", label: "LinkedIn post URL", placeholder: "https://www.linkedin.com/posts/…" },
  { id: "query", title: "LinkedIn search", description: "Find relevant posts and conversations using a search query.", label: "Search query", placeholder: "looking for a marketing agency" },
] as const;
export const CUSTOM_MONITOR = { id: "custom", title: "Start from scratch", description: "Describe the LinkedIn research you want your agent to do.", label: "What should the agent monitor on LinkedIn?", placeholder: "Describe the posts, profiles or conversations to check, and what to look for." } as const;
export type MonitorKind = typeof MONITOR_TEMPLATES[number]["id"] | "custom";

export function linkedinUrl(value: string, kind: "profile" | "post"): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
    if (kind === "post" && u.hostname === "lnkd.in") return /^\/\S+$/.test(u.pathname);
    if (!["linkedin.com", "www.linkedin.com"].includes(u.hostname)) return false;
    return kind === "profile" ? /^\/in\/[^/]+\/?$/.test(u.pathname) :
      /^\/(posts\/[^/]+|feed\/update\/urn:li:[^/]+)\/?$/.test(u.pathname);
  } catch { return false; }
}

export const MonitorInput = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["own", "team", "post", "query", "custom"]),
  source: z.string().trim().min(3).max(2500),
  icp: z.string().trim().min(3).max(1000),
  server_id: z.string().uuid(),
  frequency: z.enum(["once", "daily", "weekly"]),
  include_existing: z.boolean(),
  ends_at: z.string().datetime().nullable(),
}).strict().superRefine((v, ctx) => {
  const sources = v.source.split(/\s+/);
  if (v.kind === "post" && !linkedinUrl(v.source, "post"))
    ctx.addIssue({ code: "custom", path: ["source"], message: "Enter an HTTPS LinkedIn post URL or lnkd.in short link." });
  if ((v.kind === "own" && (sources.length !== 1 || !linkedinUrl(v.source, "profile"))) ||
      (v.kind === "team" && (sources.length > 10 || !sources.every(s => linkedinUrl(s, "profile")))))
    ctx.addIssue({ code: "custom", path: ["source"], message: "Use LinkedIn /in/ profile URLs: one for your posts, up to 10 for team posts." });
  if (v.kind === "query" && v.source.length > 500)
    ctx.addIssue({ code: "custom", path: ["source"], message: "Keep the query under 500 characters." });
});
export type MonitorConfig = z.infer<typeof MonitorInput>;
export interface Monitor extends MonitorConfig {
  id: string; active: boolean; schedule_id: string | null;
  schedule_error: string | null; created_at: string;
  last_check: { id: string; status: string; error: string; updated_at: string; coverage: string } | null;
}

export const ObservationInput = z.object({
  person_name: z.string().trim().min(1).max(200),
  profile_url: z.string().max(500).refine(v => linkedinUrl(v, "profile"), "Use a LinkedIn profile URL"),
  post_url: z.string().max(700).refine(v => linkedinUrl(v, "post"), "Use a LinkedIn post URL"),
  source_url: z.string().max(1000).refine(v => linkedinUrl(v, "post"), "Use a LinkedIn evidence URL"),
  engagement: z.enum(["comment", "mention", "reaction", "author"]),
  quote: z.string().trim().max(1000).default(""),
  company: z.string().trim().max(200).default(""),
  domain: z.string().trim().max(200).default(""),
  occurred_at: z.string().datetime().nullable(),
  why_fit: z.string().trim().min(1).max(1000),
  outreach_context: z.string().trim().min(1).max(1000),
}).strict().superRefine((v, ctx) => {
  if (v.engagement === "reaction" && v.quote)
    ctx.addIssue({ code: "custom", path: ["quote"], message: "A reaction has no quote." });
  if (["comment", "mention"].includes(v.engagement) && !v.quote)
    ctx.addIssue({ code: "custom", path: ["quote"], message: "Include the exact comment or mention text." });
});
export type Observation = z.infer<typeof ObservationInput> & {
  id: string; monitor_id: string; observed_at: string; lead_id: string | null;
};
