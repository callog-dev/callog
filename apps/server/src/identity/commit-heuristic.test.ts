import { describe, expect, it } from "vitest";
import { matchCommitAuthors, type CommitSample } from "./commit-heuristic";
import { workEmailResolver } from "./work-emails";

const known = new Set(["alice@acme.com", "bob@acme.com", "shared@acme.com"]);
const recentSince = new Date("2026-09-01T00:00:00Z");
const RECENT = new Date("2026-10-01T00:00:00Z");
const OLD = new Date("2026-03-01T00:00:00Z");
const commits = (
  login: string,
  githubId: number,
  email: string,
  n: number,
  at = RECENT,
): CommitSample[] => Array.from({ length: n }, () => ({ login, githubId, email, at }));
const match = (samples: CommitSample[], orgDomains: string[] = [], emails = known) =>
  matchCommitAuthors(samples, workEmailResolver(emails, orgDomains), recentSince);

describe("matchCommitAuthors", () => {
  it("is high for a stable, unambiguous pair with enough commits", () => {
    expect(match(commits("alice-gh", 1, "Alice@Acme.com", 3))).toEqual([
      { login: "alice-gh", githubId: 1, email: "alice@acme.com", commits: 3, confidence: "high" },
    ]);
  });

  it("is suggested below the commit threshold", () => {
    expect(match(commits("alice-gh", 1, "alice@acme.com", 2))[0]?.confidence).toBe("suggested");
  });

  it("is suggested when one email is used by several logins", () => {
    const result = match([
      ...commits("a", 1, "shared@acme.com", 5),
      ...commits("b", 2, "shared@acme.com", 5),
    ]);
    expect(result.map((r) => r.confidence)).toEqual(["suggested", "suggested"]);
  });

  it("is suggested when one login commits with several known emails", () => {
    const result = match([
      ...commits("a", 1, "alice@acme.com", 5),
      ...commits("a", 1, "bob@acme.com", 5),
    ]);
    expect(result.map((r) => r.confidence)).toEqual(["suggested", "suggested"]);
  });

  it("ignores emails that are not known work emails", () => {
    expect(match(commits("a", 1, "me@gmail.com", 10))).toEqual([]);
  });

  it("suggests a link from old commits alone", () => {
    expect(match(commits("alice-gh", 1, "alice@acme.com", 10, OLD))).toEqual([
      {
        login: "alice-gh",
        githubId: 1,
        email: "alice@acme.com",
        commits: 10,
        confidence: "suggested",
      },
    ]);
  });

  it("counts only recent commits towards high", () => {
    const twoRecent = [
      ...commits("alice-gh", 1, "alice@acme.com", 2),
      ...commits("alice-gh", 1, "alice@acme.com", 5, OLD),
    ];
    expect(match(twoRecent)[0]?.confidence).toBe("suggested");
    expect(
      match([...twoRecent, ...commits("alice-gh", 1, "alice@acme.com", 1)])[0]?.confidence,
    ).toBe("high");
  });

  describe("org email domains", () => {
    const domains = ["acme.com", "acme.io"];

    it("matches the same local part on another org domain as confidently as the exact email", () => {
      expect(match(commits("alice-gh", 1, "Alice@Acme.io", 3), domains)).toEqual([
        { login: "alice-gh", githubId: 1, email: "alice@acme.com", commits: 3, confidence: "high" },
      ]);
    });

    it("adds up commits made with either domain", () => {
      const result = match(
        [
          ...commits("alice-gh", 1, "alice@acme.io", 2),
          ...commits("alice-gh", 1, "alice@acme.com", 1),
        ],
        domains,
      );
      expect(result).toEqual([
        { login: "alice-gh", githubId: 1, email: "alice@acme.com", commits: 3, confidence: "high" },
      ]);
    });

    it("does not treat domains outside the list as synonyms", () => {
      expect(match(commits("alice-gh", 1, "alice@acme.dev", 5), domains)).toEqual([]);
      expect(match(commits("alice-gh", 1, "alice@acme.io", 5))).toEqual([]);
    });

    it("keeps the exact email when it is known itself", () => {
      const emails = new Set(["alice@acme.com", "alice@acme.io"]);
      expect(match(commits("alice-gh", 1, "alice@acme.io", 3), domains, emails)).toEqual([
        { login: "alice-gh", githubId: 1, email: "alice@acme.io", commits: 3, confidence: "high" },
      ]);
    });

    it("only suggests when the local part is known on several other org domains", () => {
      const emails = new Set(["alice@acme.com", "alice@acme.dev"]);
      const result = match(
        commits("alice-gh", 1, "alice@acme.io", 5),
        [...domains, "acme.dev"],
        emails,
      );
      expect(result.map((r) => [r.email, r.confidence])).toEqual([
        ["alice@acme.com", "suggested"],
        ["alice@acme.dev", "suggested"],
      ]);
    });
  });
});
