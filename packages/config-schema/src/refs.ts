import { z } from "zod";

export const REF_KINDS = ["email", "github", "slack", "telegram", "team", "person"] as const;
export type RefKind = (typeof REF_KINDS)[number];

/** `<kind>:<value>`, e.g. `github:octocat`, `team:frontend`. */
export type Ref = `${RefKind}:${string}`;

const SLUG = "[a-z0-9][a-z0-9-]*";

export const slugSchema = z
  .string()
  .regex(new RegExp(`^${SLUG}$`), "must be lowercase letters, digits and dashes");

export function refSchema<const K extends RefKind>(kinds: readonly K[]) {
  const pattern = new RegExp(`^(${kinds.join("|")}):\\S+$`);
  return z
    .string()
    .regex(pattern, `must be a reference like ${kinds.map((k) => `${k}:…`).join(", ")}`)
    .transform((v) => v as `${K}:${string}`);
}

/** `place:<name>`: a place declared in `places.yaml`, named by a producer as a recipient. */
export type PlaceRef = `place:${string}`;
const PLACE_REF = new RegExp(`^place:(${SLUG})$`);

export const placeRefSchema = z
  .string()
  .regex(PLACE_REF, "must be a reference like place:…")
  .transform((v) => v as PlaceRef);

/** Whom a notification is for: a person, a team or a place. */
export const recipientSchema = z.union([refSchema(REF_KINDS), placeRefSchema]);

/** The place a recipient names, or `undefined` when it is a person or a team. */
export function placeOf(recipient: string): string | undefined {
  return PLACE_REF.exec(recipient)?.[1];
}

/** A notification's recipients: the people and teams it is for, and the places it names. */
export function splitRecipients(recipients: readonly string[]): {
  people: Ref[];
  places: string[];
} {
  const people: Ref[] = [];
  const places: string[] = [];
  for (const recipient of recipients) {
    const place = placeOf(recipient);
    if (place === undefined) people.push(recipient as Ref);
    else places.push(place);
  }
  return { people, places };
}

export function parseRef(ref: Ref): { kind: RefKind; value: string } {
  const i = ref.indexOf(":");
  return { kind: ref.slice(0, i) as RefKind, value: ref.slice(i + 1) };
}
