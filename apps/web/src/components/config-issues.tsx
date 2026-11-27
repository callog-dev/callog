import type { ConfigIssue } from "@/lib/api";

/** How a problem reads by its level: an error stops something, a warning does not. */
export const ISSUE_LEVEL_TEXT = {
  error: "text-destructive",
  warning: "text-muted-foreground",
} as const;

/** Problems of a config push: file, path in the YAML and what is wrong. */
export function ConfigIssueList({
  issues,
  fileUrl,
}: {
  issues: ConfigIssue[];
  /** Links each file, e.g. to the commit that was loaded. */
  fileUrl?: (file: string) => string;
}) {
  return (
    <ul className="mt-1 list-disc space-y-1 pl-4">
      {issues.map((issue, i) => (
        <li key={i}>
          {issue.file &&
            (fileUrl ? (
              <a
                className="font-mono underline-offset-4 hover:underline"
                href={fileUrl(issue.file)}
                target="_blank"
                rel="noreferrer"
              >
                {issue.file}
              </a>
            ) : (
              <code>{issue.file}</code>
            ))}
          {issue.path.length > 0 && <code className="ml-1">› {issue.path.join(".")}</code>} —{" "}
          {issue.message}
        </li>
      ))}
    </ul>
  );
}
