import { z } from "zod";
import { refSchema, slugSchema } from "./refs";

// Strict objects everywhere: a typo in a config key must fail validation, not be ignored.
// The repo holds routing only: no person identifiers outside `examples.recipients`.

/**
 * Keys that used to hold people. Strict objects reject them anyway; the hint says
 * where that data lives now.
 */
export const REMOVED_KEYS: Record<string, string> = {
  "config.yaml admins":
    "removed: admins are GitHub org owners plus the admin role granted in /manage",
  "teams.yaml teams.*.members":
    "removed: team members come from members_from (GitHub team / Slack user group)",
};
export const REMOVED_FILES: Record<string, string> = {
  "people.yaml":
    "removed: accounts are linked by the Slack and GitHub syncs, `/notify link` and admins in /manage",
};

export const configFileSchema = z.strictObject({
  retention_days: z.number().int().min(1).max(365).default(30),
  defaults: z
    .strictObject({
      unmapped_recipient: z.enum(["plain_text"]).default("plain_text"),
    })
    .default({ unmapped_recipient: "plain_text" }),
});
export type ConfigFile = z.infer<typeof configFileSchema>;

export const teamSchema = z
  .strictObject({
    slack_channel: z.string().min(1).optional(),
    telegram_chat: z.string().min(1).optional(),
    /** The only source of a team's people: a GitHub team and/or a Slack user group. */
    members_from: z
      .strictObject({
        github_team: z.string().min(1).optional(),
        slack_usergroup: z.string().min(1).optional(),
      })
      .refine((m) => m.github_team !== undefined || m.slack_usergroup !== undefined, {
        message: "github_team or slack_usergroup is required",
      })
      .optional(),
  })
  .refine((t) => t.slack_channel || t.telegram_chat || t.members_from, {
    message: "a team needs a channel (slack_channel, telegram_chat) or members_from",
  });
export type Team = z.infer<typeof teamSchema>;

export const teamsFileSchema = z.strictObject({
  teams: z.record(slugSchema, teamSchema).default({}),
});

// Neutral template blocks. Strings are Liquid templates.
export const blockSchema = z.union([
  z.strictObject({ header: z.string().min(1) }),
  z.strictObject({ text: z.string().min(1) }),
  z.strictObject({
    fields: z.array(z.strictObject({ label: z.string().min(1), value: z.string() })).min(1),
  }),
  z.strictObject({
    buttons: z.array(z.strictObject({ text: z.string().min(1), url: z.string().min(1) })).min(1),
  }),
  z.strictObject({ context: z.string().min(1) }),
  z.strictObject({ divider: z.literal(true) }),
]);
export type Block = z.infer<typeof blockSchema>;

export const destinationSchema = z.union([
  z.strictObject({ slack: z.string().min(1) }),
  z.strictObject({ telegram: z.string().min(1) }),
  z.strictObject({ team: slugSchema }),
]);
export type Destination = z.infer<typeof destinationSchema>;

/** Examples are fixtures for CI and previews; they are never resolved to real people. */
const recipientRefSchema = refSchema(["email", "github", "slack", "telegram", "team", "person"]);

export const routeSchema = z
  .strictObject({
    id: slugSchema,
    description: z.string().optional(),
    allowed_sources: z
      .strictObject({
        github_repos: z
          .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/repo"))
          .default([]),
        api_keys: z.array(z.string().min(1)).default([]),
      })
      .refine((s) => s.github_repos.length + s.api_keys.length > 0, {
        message: "at least one github_repos or api_keys entry is required",
      }),
    destinations: z.array(destinationSchema).min(1),
    mentions: z.enum(["recipients", "none"]).default("recipients"),
    /**
     * Also send each recipient a personal copy in their preferred channel (Slack or
     * Telegram, `/notify prefs`). People can mute a route's DMs for themselves.
     */
    dm: z.boolean().default(false),
    /** JSON Schema for `data`; compiled and enforced by the API. */
    schema: z.record(z.string(), z.unknown()).optional(),
    template: z.array(blockSchema).min(1).optional(),
    /** Escape hatch: raw Slack Block Kit, Liquid applied to strings. */
    slack_blocks: z.array(z.record(z.string(), z.unknown())).min(1).optional(),
    examples: z
      .array(
        z.strictObject({
          data: z.record(z.string(), z.unknown()).default({}),
          recipients: z.array(recipientRefSchema).default([]),
        }),
      )
      .default([]),
  })
  .refine((r) => r.template !== undefined || r.slack_blocks !== undefined, {
    message: "either template or slack_blocks is required",
    path: ["template"],
  });
export type Route = z.infer<typeof routeSchema>;
