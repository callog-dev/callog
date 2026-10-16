import type { Confidence } from "../db/schema";

export interface CommitSample {
  /** GitHub account the commit is attributed to (GitHub resolves it from the commit email). */
  login: string;
  githubId: number;
  email: string;
}

export interface CommitMatch {
  login: string;
  githubId: number;
  email: string;
  commits: number;
  confidence: Extract<Confidence, "high" | "suggested">;
}

const MIN_COMMITS_FOR_HIGH = 3;

/**
 * Pairs GitHub logins with known work emails from commit history.
 *
 * `high` when the login committed with the email at least MIN_COMMITS_FOR_HIGH times and
 * neither side is ambiguous (the email maps to one login, the login to one known email);
 * otherwise `suggested`, which goes to the admin queue instead of being used for mentions.
 * Emails that are not already known work emails are ignored: the heuristic only links
 * accounts to people anchored elsewhere.
 */
export function matchCommitAuthors(
  samples: CommitSample[],
  knownEmails: ReadonlySet<string>,
): CommitMatch[] {
  const pairs = new Map<string, Omit<CommitMatch, "confidence">>();
  for (const sample of samples) {
    const email = sample.email.toLowerCase();
    if (!knownEmails.has(email)) continue;
    const key = `${sample.githubId}\n${email}`;
    const pair = pairs.get(key) ?? {
      login: sample.login,
      githubId: sample.githubId,
      email,
      commits: 0,
    };
    pair.commits++;
    pairs.set(key, pair);
  }

  const loginsPerEmail = new Map<string, Set<number>>();
  const emailsPerLogin = new Map<number, Set<string>>();
  for (const { githubId, email } of pairs.values()) {
    loginsPerEmail.set(email, (loginsPerEmail.get(email) ?? new Set()).add(githubId));
    emailsPerLogin.set(githubId, (emailsPerLogin.get(githubId) ?? new Set()).add(email));
  }

  return [...pairs.values()].map((pair) => {
    const unambiguous =
      loginsPerEmail.get(pair.email)!.size === 1 && emailsPerLogin.get(pair.githubId)!.size === 1;
    return {
      ...pair,
      confidence: unambiguous && pair.commits >= MIN_COMMITS_FOR_HIGH ? "high" : "suggested",
    };
  });
}
