/** An email → the known work emails it stands for: none, one, or several (ambiguous). */
export type WorkEmailResolver = (email: string) => string[];

/**
 * Resolves an email to known work emails: itself when known, otherwise the same local part on
 * the organization's other email domains (`alice@acme.com` stands for `alice@acme.io` when
 * both are org domains). `orgDomains` come lowercased from the config schema.
 */
export function workEmailResolver(
  knownEmails: ReadonlySet<string>,
  orgDomains: readonly string[],
): WorkEmailResolver {
  return (raw) => {
    const email = raw.toLowerCase();
    if (knownEmails.has(email)) return [email];
    const at = email.lastIndexOf("@");
    const domain = email.slice(at + 1);
    if (at <= 0 || !orgDomains.includes(domain)) return [];
    const local = email.slice(0, at);
    return orgDomains
      .filter((d) => d !== domain)
      .map((d) => `${local}@${d}`)
      .filter((candidate) => knownEmails.has(candidate));
  };
}
