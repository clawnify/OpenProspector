import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ReviewRoute } from "../routes/review";
import { ContactFields, MonitorForm, Finding, SignalRow, signalStatus, signalSummary } from "./signal-monitors";
import { CustomObservationInput, findsContacts, type Monitor } from "../../shared/monitors";

const form = (kind: Parameters<typeof MonitorForm>[0]["kind"], listName?: string) =>
  renderToStaticMarkup(<MonitorForm kind={kind} listId="l1" listName={listName} onClose={() => {}} onSaved={() => {}} />);

it("To review creates nothing: searches are made inside a list", () => {
  const html = renderToStaticMarkup(<MemoryRouter><ReviewRoute /></MemoryRouter>);
  expect(html).toContain("searches in no list");
  expect(html).toContain("Findings");
  expect(html).not.toContain("New signal");
  expect(html).not.toContain("Your monitors");
});

it("opens a list's first search like a prompt box: who should this list find, named after the list", () => {
  const html = form("custom", "Bol opportunities");
  expect(html).toContain("Who should this list find?");
  expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
  expect(html).toContain("Which companies should it find?");
  expect(html).toContain("Add to list");
  // Repeat and the limit are in view; the name, end date and first-run choice wait under More settings.
  expect(html).toContain("Every week");
  expect(html).toContain('value="10"');
  expect(html).toContain("More settings");
  expect(html).not.toContain('value="Bol opportunities"');
  expect(html).not.toContain("Include what already exists");
  expect(html).not.toContain("LinkedIn");
  expect(html).not.toContain("Who should we look for?");
});

it.each(["own", "team", "post", "query"] as const)("keeps the LinkedIn fields in the %s template", kind => {
  const html = form(kind);
  expect(html).toContain("LinkedIn");
  expect(html).toContain("Who should we look for?");
  expect(html).toContain("join this list");
});

it.each(["company", "person"] as const)("renders a custom %s with evidence and signal reason", type => {
  const details = CustomObservationInput.parse({ kind: "custom", subject: type === "company" ? { type, name: "SGM Magnetics", domain: "sgmmagnetics.com" } : { type, name: "Test Person", profile_url: "https://agency.example/team/person" }, source_url: "https://magazine.example/article", summary: "Relevant industry coverage", reason: "Matches the requested news topic", occurred_at: null });
  const html = renderToStaticMarkup(<MemoryRouter><Finding item={{ ...details, id: "test", monitor_id: "test", lead_id: null, observed_at: "2026-09-14", search: null }} onChanged={() => {}} /></MemoryRouter>);
  expect(html).toContain(details.subject.name);
  expect(html).toContain(details.reason);
  expect(html).toContain('href="https://magazine.example/article"');
  expect(html).not.toContain("ICP fit");
  if (type === "company") {
    expect(html).not.toContain("Add to leads");
    expect(html).toContain("Find people");
  } else {
    expect(html).toContain("Add to leads");
    expect(html).not.toContain("Find people");
  }
});

const company = CustomObservationInput.parse({ kind: "custom", subject: { type: "company", name: "Loodgieter.nl", domain: "loodgieter.nl" }, source_url: "https://www.loodgieter.nl/amsterdam", summary: "Runs electric service vans in Amsterdam", reason: "Shows its van fleet", occurred_at: null });
const withSearch = (search: Record<string, unknown>) => renderToStaticMarkup(<MemoryRouter><Finding item={{ ...company, id: "o1", monitor_id: "m1", lead_id: null, observed_at: "2026-10-05",
  search: { id: "r1", status: "done", error: "", lead_count: 0, stale: 0, ...search } }} onChanged={() => {}} /></MemoryRouter>);

it.each([
  [{ status: "done", lead_count: 2 }, "2 people to contact"],
  [{ status: "done", lead_count: 1 }, "1 person to contact"],
  [{ status: "done", lead_count: 0 }, "No one found to contact"],
  [{ status: "sourcing" }, "Finding who to contact"],
  [{ status: "sourcing", stale: 1 }, "stopped reporting"],
  [{ status: "pending", error: "Choose an agent in Settings" }, "hand it to your agent: Choose an agent in Settings"],
  [{ status: "failed", error: "Site blocked" }, "Search failed: Site blocked"],
])("shows where the company's search stands: %o", (search, text) => {
  const html = withSearch(search);
  expect(html).toContain(text);
  expect(html).not.toContain("Find people");
  expect(html).not.toContain("Add to leads");
});

it("links found people to Leads opened on that search, and offers a retry only where one helps", () => {
  expect(withSearch({ status: "done", lead_count: 2 })).toContain('href="/leads?run=r1"');
  expect(withSearch({ status: "done", lead_count: 2 })).not.toContain("Retry");
  expect(withSearch({ status: "sourcing" })).not.toContain("Retry");
  expect(withSearch({ status: "failed", error: "x" })).toContain("Retry");
  expect(withSearch({ status: "sourcing", stale: 1 })).toContain("Retry");
});

it("asks a custom signal whether it finds companies or people; companies come with who to contact, on by default", () => {
  const custom = form("custom");
  expect(custom).toContain("What should it find?");
  expect(custom).toMatch(/aria-pressed="true"[^>]*>Companies</);
  expect(custom).toMatch(/aria-pressed="false"[^>]*>People</);
  expect(custom).toMatch(/type="checkbox" checked=""\/>.{0,20}Find who to contact at each company/);
  expect(custom).toContain("Who to contact (optional)");
  // In words the agent reads, not a title filter.
  expect(custom).toContain("For example: the Creative Director, or the operations manager");
  const linkedin = form("post");
  expect(linkedin).not.toContain("What should it find?");
  expect(linkedin).not.toContain("Find who to contact");
});

it("asks who to contact only while it looks for them by itself", () => {
  const fields = (contacts: boolean) => renderToStaticMarkup(<ContactFields contacts={contacts} onContacts={() => {}} who="the Creative Director" onWho={() => {}} />);
  expect(fields(true)).toContain("Who to contact (optional)");
  expect(fields(true)).toContain('value="the Creative Director"');
  expect(fields(false)).not.toContain("Who to contact (optional)");
  expect(fields(false)).toContain("press Find people on the ones you want");
});

it("looks for who to contact by itself only as set, and a signal saved before the choice while it feeds a list", () => {
  const signal = { kind: "custom" as const, lists_fed: 0 };
  expect(findsContacts({ ...signal, finds: "companies", find_contacts: true })).toBe(true);
  expect(findsContacts({ ...signal, finds: "companies", find_contacts: false, lists_fed: 2 })).toBe(false);
  expect(findsContacts({ ...signal, finds: "people" })).toBe(false);
  expect(findsContacts(signal)).toBe(false);
  expect(findsContacts({ ...signal, lists_fed: 1 })).toBe(true);
  expect(findsContacts({ kind: "post", lists_fed: 1 })).toBe(false);
});

it("asks how many new finds a run may record, 10 to start", () => {
  const html = form("post");
  expect(html).toMatch(/new people(<!-- -->)? a run/);
  expect(html).toContain('value="10"');
  expect(html).not.toContain("<select");
  expect(form("custom")).toMatch(/new companies(<!-- -->)? a run/);
});

const monitor = (over: Partial<Monitor> = {}): Monitor => ({
  id: "m1", name: "Amazon brands, Bol opportunities", kind: "custom", source: "Brands that sell on Amazon but not on Bol.\nSkip resellers.",
  icp: "", server_id: "46d3c39e-d490-433d-b27c-db7e2d6fd396", frequency: "biweekly", include_existing: true, ends_at: null,
  max_per_check: 5, who_to_contact: "The owner", finds: "companies", find_contacts: true, active: true, schedule_id: "s1",
  schedule_error: null, created_at: "2026-11-09 15:00:00", lists_fed: 1,
  last_check: { id: "c1", status: "done", error: "", updated_at: "2026-11-09 15:30:00", coverage: "Ran 5 searches and read 9 pages." },
  ...over,
});

it("shows a signal as one line of what it finds and how often, with the prompt and the run report under Details", () => {
  expect(signalSummary(monitor())).toBe("Finds companies · Every 2 weeks · up to 5 a run · finds who to contact");
  expect(signalSummary(monitor({ kind: "post", finds: undefined, find_contacts: undefined, frequency: "daily" }))).toBe("LinkedIn: Specific post · Every day · up to 5 a run");
  const html = renderToStaticMarkup(<SignalRow monitor={monitor()} onChanged={() => {}} />);
  expect(html).toContain("Amazon brands, Bol opportunities");
  expect(html).toContain("Details");
  expect(html).toContain("Run now");
  expect(html).not.toContain("Skip resellers");
  expect(html).not.toContain("Ran 5 searches");
});

it("says where a signal stands in words", () => {
  expect(signalStatus(monitor({ last_check: null })).text).toBe("Not run yet");
  expect(signalStatus(monitor({ last_check: { ...monitor().last_check!, status: "sourcing" } })).text).toBe("Running now");
  expect(signalStatus(monitor({ active: false }))).toMatchObject({ text: expect.stringContaining("Paused") });
  expect(signalStatus(monitor({ last_check: { ...monitor().last_check!, status: "failed", error: "Login required." } })))
    .toMatchObject({ tone: "danger", text: expect.stringMatching(/failed: Login required$/) });
  expect(signalStatus(monitor({ schedule_error: "Agent offline" })).tone).toBe("danger");
});
