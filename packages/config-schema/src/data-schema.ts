import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

export interface DataIssue {
  /** `data.branch`, `data` for the whole object. */
  path: string;
  message: string;
}

/**
 * One Ajv for route `schema`s — the same rules the API enforces on `data`. Compiled schemas
 * are not registered (`addUsedSchema: false`): otherwise the same `$id` compiled twice
 * (another route, a reload, another tenant) throws, and schemas could `$ref` each other
 * across tenants.
 */
const ajv = new Ajv({ allErrors: true, strict: false, addUsedSchema: false });
(addFormats as unknown as (a: Ajv) => void)(ajv);

/** Compiles a route `schema`; throws with Ajv's message when it is not valid JSON Schema. */
export function compileDataSchema(schema: Record<string, unknown>): ValidateFunction {
  return ajv.compile(schema);
}

export function dataIssues(validate: ValidateFunction, data: unknown): DataIssue[] {
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => ({
    path: `data${e.instancePath.replace(/\//g, ".")}`,
    message: e.message ?? "is invalid",
  }));
}
