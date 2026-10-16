import { z } from "zod";

export const REF_KINDS = ["email", "github", "slack", "telegram", "team", "person"] as const;
export type RefKind = (typeof REF_KINDS)[number];

/** `<kind>:<value>`, e.g. `github:octocat`, `team:frontend`. */
export type Ref = `${RefKind}:${string}`;

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and dashes");

export function refSchema<const K extends RefKind>(kinds: readonly K[]) {
  const pattern = new RegExp(`^(${kinds.join("|")}):\\S+$`);
  return z
    .string()
    .regex(pattern, `must be a reference like ${kinds.map((k) => `${k}:…`).join(", ")}`)
    .transform((v) => v as `${K}:${string}`);
}

export function parseRef(ref: Ref): { kind: RefKind; value: string } {
  const i = ref.indexOf(":");
  return { kind: ref.slice(0, i) as RefKind, value: ref.slice(i + 1) };
}
