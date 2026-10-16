import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { compileDataSchema, dataIssues, type DataIssue } from "@callog/config-schema";
import { setBounded } from "../common/bounded-map";
import type { ValidateFunction } from "ajv";

/** Compiled validators kept (config version × route); old versions fall out first. */
const MAX_VALIDATORS = 1_000;

/**
 * Validates `data` against a route's JSON Schema (`schema`) with the same
 * rules `notify validate` uses. Compiled validators are cached per config version and route.
 */
@Injectable()
export class DataValidator {
  private readonly cache = new Map<string, ValidateFunction>();

  validate(cacheKey: string, schema: Record<string, unknown>, data: unknown): DataIssue[] {
    let validate = this.cache.get(cacheKey);
    if (!validate) {
      try {
        validate = compileDataSchema(schema);
      } catch (err) {
        // Config validation rejects such schemas; this only guards against older versions.
        throw new InternalServerErrorException(`Route schema is invalid: ${String(err)}`);
      }
      setBounded(this.cache, cacheKey, validate, MAX_VALIDATORS);
    }
    return dataIssues(validate, data);
  }
}
