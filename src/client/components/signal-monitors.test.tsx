import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SignalsRoute } from "../routes/signals";
import { ContactFields, MonitorForm, Finding } from "./signal-monitors";
import { CustomObservationInput, findsContacts } from "../../shared/monitors";

it("keeps templates out of the normal feed and provides an explicit creation entry point", () => {
  const html = renderToStaticMarkup(<MemoryRouter><SignalsRoute /></MemoryRouter>);
  expect(html).toContain("New signal");
  expect(html).toContain("Your monitors");
  expect(html).toContain("Signal findings");
  expect(html).not.toContain("Choose a signal template");
  expect(html).not.toContain("My LinkedIn posts");
  expect(html).not.toContain("Start from scratch");
  expect(html).not.toContain("Live only");
});

it("starts custom monitors with blank name and prompt, no LinkedIn fields or separate ICP", () => {
  const html = renderToStaticMarkup(<MonitorForm kind="custom" onClose={() => {}} onSaved={() => {}} />);
  expect(html).toContain("Which companies should it find?");
  expect(html).toContain('value=""');
  expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
  expect(html).toContain("person or company");
  expect(html).toContain("Include existing findings");
  expect(html).not.toContain("LinkedIn");
  expect(html).not.toContain("Who should we look for?");
});

it.each(["own", "team", "post", "query"] as const)("preserves LinkedIn fields in the %s template", kind => {
  const html = renderToStaticMarkup(<MonitorForm kind={kind} onClose={() => {}} onSaved={() => {}} />);
  expect(html).toContain("LinkedIn");
  expect(html).toContain("Who should we look for?");
  expect(html).toContain("Include existing engagement");
});

it.each(["company", "person"] as const)("renders a custom %s with evidence and signal reason", type => {
  const details = CustomObservationInput.parse({ kind: "custom", subject: type === "company" ? { type, name: "SGM Magnetics", domain: "sgmmagnetics.com" } : { type, name: "Test Person", profile_url: "https://agency.example/team/person" }, source_url: "https://magazine.example/article", summary: "Relevant industry coverage", reason: "Matches the requested news topic", occurred_at: null });
  const html = renderToStaticMarkup(<MemoryRouter><Finding item={{ ...details, id: "test", monitor_id: "test", lead_id: null, observed_at: "2026-09-14", search: null }} onChanged={() => {}} /></MemoryRouter>);
  expect(html).toContain(details.subject.name);
  expect(html).toContain(details.reason);
  expect(html).toContain('href="https://magazine.example/article"');
  expect(html).not.toContain("ICP fit");
  if (type === "company") {
    expect(html).not.toContain("Add to people");
    expect(html).toContain("Find people");
  } else {
    expect(html).toContain("Add to people");
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
  expect(html).not.toContain("Add to people");
});

it("links found people to Leads opened on that search, and offers a retry only where one helps", () => {
  expect(withSearch({ status: "done", lead_count: 2 })).toContain('href="/?run=r1"');
  expect(withSearch({ status: "done", lead_count: 2 })).not.toContain("Retry");
  expect(withSearch({ status: "sourcing" })).not.toContain("Retry");
  expect(withSearch({ status: "failed", error: "x" })).toContain("Retry");
  expect(withSearch({ status: "sourcing", stale: 1 })).toContain("Retry");
});

it("asks a custom signal whether it finds companies or people; companies come with who to contact, on by default", () => {
  const custom = renderToStaticMarkup(<MonitorForm kind="custom" onClose={() => {}} onSaved={() => {}} />);
  expect(custom).toContain("What should it find?");
  expect(custom).toMatch(/aria-pressed="true"[^>]*>Companies</);
  expect(custom).toMatch(/aria-pressed="false"[^>]*>People</);
  expect(custom).toMatch(/type="checkbox" checked=""\/>.{0,20}Find who to contact at each company/);
  expect(custom).toContain("Who to contact (optional)");
  // In words the agent reads, not a title filter.
  expect(custom).toContain("For example: the Creative Director, or the operations manager");
  const linkedin = renderToStaticMarkup(<MonitorForm kind="post" onClose={() => {}} onSaved={() => {}} />);
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

it("asks how many new people a check may record, 25 to start", () => {
  const html = renderToStaticMarkup(<MonitorForm kind="post" onClose={() => {}} onSaved={() => {}} />);
  expect(html).toMatch(/new people(<!-- -->)? per check/);
  expect(html).toContain('value="25"');
  expect(html).not.toContain("<select");
  const custom = renderToStaticMarkup(<MonitorForm kind="custom" onClose={() => {}} onSaved={() => {}} />);
  expect(custom).toMatch(/new companies(<!-- -->)? per check/);
});
