import { signalSkill, customSignalSkill } from "./signal-skill.gen.js";
import type { MonitorKind } from "../shared/monitors.js";

/** Full versioned skill snapshot travels in both native schedules and tasks. */
export function signalBrief(appUrl: string, monitorId: string, checkId?: string, kind: MonitorKind = "post") {
  const skill = kind === "custom" ? customSignalSkill : signalSkill;
  const url = new URL(appUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))))
    throw new Error("The app URL must be an HTTPS origin");
  for (const id of [monitorId, checkId].filter(Boolean))
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id!)) throw new Error("Invalid monitor/check ID");
  const task = JSON.stringify({ app_url: url.origin, monitor_id: monitorId, ...(checkId ? { check_id: checkId } : {}) });
  const text = `${skill.content}\nSnapshot sha256: ${skill.hash}\nTask data: ${task}`;
  if (text.length > 4000) throw new Error("The signal skill exceeds the agent's 4,000-character prompt limit.");
  return text;
}
