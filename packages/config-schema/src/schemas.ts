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

/** A room of one channel: a Slack channel (name or id) or a Telegram chat id. */
export const placeSchema = z.union([
  z.strictObject({ slack: z.string().min(1) }),
  z.strictObject({ telegram: z.string().min(1) }),
]);
export type Place = z.infer<typeof placeSchema>;

/** Places by name: routes and producers say `deploys`, only this file says where that is. */
export const placesFileSchema = z.strictObject({
  places: z.record(slugSchema, placeSchema).default({}),
});

// Neutral template blocks. Strings are Liquid templates.
export const blockSchema = z.union([
  z.strictObject({ header: z.string().min(1) }),
  z.strictObject({ text: z.string().min(1) }),
  z.strictObject({
    fields: z.array(z.strictObject({ label: z.string().min(1), value: z.string() })).min(1),
  }),
  z.strictObject({ context: z.string().min(1) }),
  z.strictObject({ divider: z.literal(true) }),
  /** Link buttons. */
  z.strictObject({
    actions: z.array(z.strictObject({ text: z.string().min(1), url: z.string().min(1) })).min(1),
  }),
]);
export type Block = z.infer<typeof blockSchema>;

export const destinationSchema = z.union([
  ...placeSchema.options,
  z.strictObject({ place: slugSchema }),
  z.strictObject({ team: slugSchema }),
]);
export type Destination = z.infer<typeof destinationSchema>;

/** Examples are fixtures for CI and previews; they are never resolved to real people. */
const recipientRefSchema = refSchema(["email", "github", "slack", "telegram", "team", "person"]);

export const routeSchema = z.strictObject({
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
  destinations: z.array(destinationSchema).default([]),
  /**
   * For a route without destinations: where a notification is posted when it reaches
   * nobody else — its recipients name no place and get no personal copy.
   */
  default_place: slugSchema.optional(),
  /**
   * Recipients the route adds on its own, for senders that cannot name any (inbound
   * webhooks). Each entry is a Liquid template over `data` that renders to recipients
   * separated by spaces or commas; anything that is not a recipient is left out.
   */
  recipients: z.array(z.string().min(1)).default([]),
  mentions: z.enum(["recipients", "none"]).default("recipients"),
  /**
   * Also send each recipient a personal copy in their preferred channel (Slack or
   * Telegram, `/notify prefs`). People can mute a route's DMs for themselves.
   */
  dm: z.boolean().default(false),
  /** JSON Schema for `data`; compiled and enforced by the API. */
  schema: z.record(z.string(), z.unknown()).optional(),
  template: z.array(blockSchema).min(1),
  examples: z
    .array(
      z.strictObject({
        data: z.record(z.string(), z.unknown()).default({}),
        recipients: z.array(recipientRefSchema).default([]),
      }),
    )
    .default([]),
});
export type Route = z.infer<typeof routeSchema>;
