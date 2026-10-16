import { describe, expect, it } from "vitest";
import { setBounded } from "./bounded-map";

describe("setBounded", () => {
  it("drops the least recently written entries beyond the limit", () => {
    const map = new Map<string, number>();
    setBounded(map, "a", 1, 2);
    setBounded(map, "b", 2, 2);
    setBounded(map, "a", 3, 2); // rewritten: now the newest
    setBounded(map, "c", 4, 2);
    expect([...map]).toEqual([
      ["a", 3],
      ["c", 4],
    ]);
  });
});
