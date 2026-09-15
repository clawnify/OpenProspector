import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SignalsRoute } from "../routes/signals";
import { MonitorForm, Finding } from "./signal-monitors";
import { CustomObservationInput } from "../../shared/monitors";

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
  expect(html).toContain("Prompt");
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
  const html = renderToStaticMarkup(<MemoryRouter><Finding item={{ ...details, id: "test", monitor_id: "test", lead_id: null, observed_at: "2026-09-14" }} onChanged={() => {}} /></MemoryRouter>);
  expect(html).toContain(details.subject.name);
  expect(html).toContain(details.reason);
  expect(html).toContain('href="https://magazine.example/article"');
  expect(html).not.toContain("ICP fit");
  if (type === "company") expect(html).not.toContain("Add to people");
  else expect(html).toContain("Add to people");
});
