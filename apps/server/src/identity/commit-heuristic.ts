import type { Confidence } from "../db/schema";
import type { WorkEmailResolver } from "./work-emails";

export interface CommitSample {
  /** GitHub account the commit is attributed to (GitHub resolves it from the commit email). */
  login: string;
  githubId: number;
  email: string;
  at: Date;
}

export interface CommitMatch {
  login: string;
  githubId: number;
  /** The known work email the commits were matched to. */
  email: string;
  commits: number;
  confidence: Extract<Confidence, "high" | "suggested">;
}

const MIN_COMMITS_FOR_HIGH = 3;

/**
 * Pairs GitHub logins with known work emails from commit history.
 *
 * `high` when the login committed with the email at least MIN_COMMITS_FOR_HIGH times since
 * `recentSince` and neither side is ambiguous (the email maps to one login, the login to one
 * known email); otherwise `suggested`, which goes to the admin queue instead of being used
 * for mentions. Emails that resolve to no known work email are ignored: the heuristic only
 * links accounts to people anchored elsewhere. An email resolving to several known ones pairs
 * with each, which makes them ambiguous.
 */
export function matchCommitAuthors(
  samples: CommitSample[],
  resolve: WorkEmailResolver,
  recentSince: Date,
): CommitMatch[] {
  const pairs = new Map<string, Omit<CommitMatch, "confidence"> & { recent: number }>();
  for (const sample of samples) {
    for (const email of resolve(sample.email)) {
      const key = `${sample.githubId}\n${email}`;
      const pair = pairs.get(key) ?? {
        login: sample.login,
        githubId: sample.githubId,
        email,
        commits: 0,
        recent: 0,
      };
      pair.commits++;
      if (sample.at >= recentSince) pair.recent++;
      pairs.set(key, pair);
    }
  }

  const loginsPerEmail = new Map<string, Set<number>>();
  const emailsPerLogin = new Map<number, Set<string>>();
  for (const { githubId, email } of pairs.values()) {
    loginsPerEmail.set(email, (loginsPerEmail.get(email) ?? new Set()).add(githubId));
    emailsPerLogin.set(githubId, (emailsPerLogin.get(githubId) ?? new Set()).add(email));
  }

  return [...pairs.values()].map(({ recent, ...pair }) => {
    const unambiguous =
      loginsPerEmail.get(pair.email)!.size === 1 && emailsPerLogin.get(pair.githubId)!.size === 1;
    return {
      ...pair,
      confidence: unambiguous && recent >= MIN_COMMITS_FOR_HIGH ? "high" : "suggested",
    };
  });
}
