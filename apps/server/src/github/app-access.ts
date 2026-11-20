/**
 * What the server needs from its GitHub App. The setup page registers an App with exactly
 * this; an App registered by hand, or changed later, is checked against it.
 */
export const APP_PERMISSIONS = { contents: "read", metadata: "read", members: "read" } as const;
export const APP_EVENTS = ["push", "organization"] as const;

/** What an installation actually grants: its permissions and the events it is sent. */
export interface AppAccess {
  permissions: Record<string, string | undefined>;
  events: string[];
}

export interface AccessGaps {
  permissions: string[];
  events: string[];
}

/** Every need is read access, so any granted level of a permission covers it. */
export function accessGaps(access: AppAccess): AccessGaps {
  return {
    permissions: Object.keys(APP_PERMISSIONS).filter((name) => !access.permissions[name]),
    events: APP_EVENTS.filter((event) => !access.events.includes(event)),
  };
}

export function hasGaps(gaps: AccessGaps): boolean {
  return gaps.permissions.length > 0 || gaps.events.length > 0;
}

/** What to grant and where, as the end of a sentence. */
export function describeGaps(gaps: AccessGaps): string {
  const parts = [
    gaps.permissions.length > 0 && `permissions (read): ${gaps.permissions.join(", ")}`,
    gaps.events.length > 0 && `events: ${gaps.events.join(", ")}`,
  ].filter(Boolean);
  return (
    `the GitHub App is missing ${parts.join("; ")}. Add them in the App's settings ` +
    "(Permissions & events); an organization owner then accepts the new permissions"
  );
}
