// The window and dedupe rules are the whole reason this table exists, so they
// get a test rather than a code review. The failure they prevent is concrete:
// a re-sweep opening a second Prospector run for a job post already seen, and
// a six-month-old posting reaching a person as if it were news.

import { describe, expect, it } from "vitest";
import {
  ageDays,
  dedupeKey,
  isLive,
  normalizeDomain,
  normalizeUrl,
  stackCounts,
  windowDaysFor,
  OTHER_WINDOW_DAYS,
} from "./signals";

const NOW = new Date("2026-09-11T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("normalizeDomain", () => {
  it.each([
    ["https://www.Acme.com/careers?x=1", "acme.com"],
    ["ACME.com", "acme.com"],
    ["http://acme.com:8080/x", "acme.com"],
    ["someone@acme.com", "acme.com"],
    ["www.acme.com", "acme.com"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it("returns empty for empty input rather than throwing", () => {
    expect(normalizeDomain("")).toBe("");
  });
});

describe("normalizeUrl", () => {
  it("keeps the posting id, which job boards put in the query string", () => {
    expect(normalizeUrl("https://boards.example.com/job?jk=abc123")).toContain("jk=abc123");
  });

  it("drops campaign parameters so the same posting shared twice is one signal", () => {
    const a = normalizeUrl("https://boards.example.com/job?jk=abc123&utm_source=x&utm_medium=y");
    const b = normalizeUrl("https://boards.example.com/job?jk=abc123");
    expect(a).toBe(b);
  });

  it("ignores scheme, www and fragment differences", () => {
    expect(normalizeUrl("http://www.boards.example.com/job#apply")).toBe(
      normalizeUrl("https://boards.example.com/job"),
    );
  });

  it("does not throw on a malformed url", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("dedupeKey", () => {
  it("is stable across the cosmetic differences between two sightings", () => {
    const first = dedupeKey("https://www.Acme.com", "Hiring", "https://boards.example.com/job?jk=1&utm_source=rss");
    const second = dedupeKey("acme.com", "hiring", "http://boards.example.com/job?jk=1#apply");
    expect(first).toBe(second);
  });

  it("separates two signal types on the same company", () => {
    expect(dedupeKey("acme.com", "hiring", "https://x.example/1")).not.toBe(
      dedupeKey("acme.com", "funding", "https://x.example/1"),
    );
  });
});

describe("ageDays", () => {
  it("counts whole days", () => {
    expect(ageDays(daysAgo(10), NOW)).toBe(10);
  });

  it("returns null for a date it cannot parse", () => {
    expect(ageDays("two weeks ago", NOW)).toBeNull();
  });

  it("clamps a future date to zero instead of treating it as extra fresh", () => {
    expect(ageDays(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW)).toBe(0);
  });
});

describe("isLive", () => {
  it("keeps a job post inside the 21 day window", () => {
    expect(isLive("hiring", daysAgo(20), NOW)).toBe(true);
  });

  it("drops the six-month-old posting that is the classic stale-signal failure", () => {
    expect(isLive("hiring", daysAgo(180), NOW)).toBe(false);
  });

  it("keeps a three-week-old funding round, which a flat 7 day sweep would have thrown away", () => {
    expect(isLive("funding", daysAgo(21), NOW)).toBe(true);
  });

  it("drops funding past eight weeks", () => {
    expect(isLive("funding", daysAgo(60), NOW)).toBe(false);
  });

  it("treats an undateable signal as not live", () => {
    expect(isLive("hiring", "recently", NOW)).toBe(false);
  });

  it("falls back to the short window for an unknown type", () => {
    expect(windowDaysFor("mystery")).toBe(OTHER_WINDOW_DAYS);
    expect(isLive("mystery", daysAgo(OTHER_WINDOW_DAYS + 1), NOW)).toBe(false);
  });
});

describe("stackCounts", () => {
  it("counts distinct live types per company", () => {
    const counts = stackCounts(
      [
        { domain: "acme.com", type: "hiring", occurred_at: daysAgo(2) },
        { domain: "https://www.acme.com/x", type: "funding", occurred_at: daysAgo(10) },
        { domain: "bolt.com", type: "hiring", occurred_at: daysAgo(1) },
      ],
      NOW,
    );
    expect(counts.get("acme.com")).toBe(2);
    expect(counts.get("bolt.com")).toBe(1);
  });

  it("does not let two sightings of the same type look like a stack", () => {
    const counts = stackCounts(
      [
        { domain: "acme.com", type: "hiring", occurred_at: daysAgo(1) },
        { domain: "acme.com", type: "hiring", occurred_at: daysAgo(3) },
      ],
      NOW,
    );
    expect(counts.get("acme.com")).toBe(1);
  });

  it("excludes stale signals, so an account cannot stack on history alone", () => {
    const counts = stackCounts(
      [
        { domain: "acme.com", type: "hiring", occurred_at: daysAgo(200) },
        { domain: "acme.com", type: "funding", occurred_at: daysAgo(5) },
      ],
      NOW,
    );
    expect(counts.get("acme.com")).toBe(1);
  });
});
