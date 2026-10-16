import { describe, expect, it } from "vitest";
import { matchCommitAuthors, type CommitSample } from "./commit-heuristic";

const known = new Set(["alice@acme.com", "bob@acme.com", "shared@acme.com"]);
const commits = (login: string, githubId: number, email: string, n: number): CommitSample[] =>
  Array.from({ length: n }, () => ({ login, githubId, email }));

describe("matchCommitAuthors", () => {
  it("is high for a stable, unambiguous pair with enough commits", () => {
    expect(matchCommitAuthors(commits("alice-gh", 1, "Alice@Acme.com", 3), known)).toEqual([
      { login: "alice-gh", githubId: 1, email: "alice@acme.com", commits: 3, confidence: "high" },
    ]);
  });

  it("is suggested below the commit threshold", () => {
    expect(
      matchCommitAuthors(commits("alice-gh", 1, "alice@acme.com", 2), known)[0]?.confidence,
    ).toBe("suggested");
  });

  it("is suggested when one email is used by several logins", () => {
    const result = matchCommitAuthors(
      [...commits("a", 1, "shared@acme.com", 5), ...commits("b", 2, "shared@acme.com", 5)],
      known,
    );
    expect(result.map((r) => r.confidence)).toEqual(["suggested", "suggested"]);
  });

  it("is suggested when one login commits with several known emails", () => {
    const result = matchCommitAuthors(
      [...commits("a", 1, "alice@acme.com", 5), ...commits("a", 1, "bob@acme.com", 5)],
      known,
    );
    expect(result.map((r) => r.confidence)).toEqual(["suggested", "suggested"]);
  });

  it("ignores emails that are not known work emails", () => {
    expect(matchCommitAuthors(commits("a", 1, "me@gmail.com", 10), known)).toEqual([]);
  });
});
