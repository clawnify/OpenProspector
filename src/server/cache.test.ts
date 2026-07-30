// The cutoff modifier decides whether a stale contact gets served as "verified".
// Bad input must fail closed (expire everything) rather than open.

import { describe, expect, it } from "vitest";
import { ageModifier } from "./cache";

describe("ageModifier", () => {
  it("formats a normal cap as a SQLite date modifier", () => {
    expect(ageModifier(90)).toBe("-90 days");
  });

  it("floors fractional days rather than emitting an unparseable modifier", () => {
    expect(ageModifier(7.9)).toBe("-7 days");
  });

  it.each([0, -1, -90, NaN, Infinity])(
    "clamps %p to a zero-day cutoff so bad input expires everything instead of nothing",
    (bad) => {
      // '-0 days' matches no rows (verified against SQLite); a negative modifier
      // would push the cutoff into the future and match every row forever.
      expect(ageModifier(bad as number)).toBe("-0 days");
    },
  );
});
