import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SignalsRoute } from "../routes/signals";

it("keeps templates out of the normal feed and provides an explicit creation entry point", () => {
  const html = renderToStaticMarkup(<MemoryRouter><SignalsRoute /></MemoryRouter>);
  expect(html).toContain("New signal");
  expect(html).toContain("Your monitors");
  expect(html).toContain("Engagement findings");
  expect(html).not.toContain("Choose a signal template");
  expect(html).not.toContain("My LinkedIn posts");
  expect(html).not.toContain("Start from scratch");
  expect(html).not.toContain("Live only");
});
