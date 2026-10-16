import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

const base = { DATABASE_URL: "postgres://u:p@db:5432/notify" };

describe("loadEnv", () => {
  it("treats empty variables as unset, as .env files and compose pass them", () => {
    const env = loadEnv({
      ...base,
      DATABASE_URL_DIRECT: "",
      DATABASE_SSL_CA_PATH: "",
      ADMIN_TOKEN: "",
      GITHUB_APP_ID: "",
      PORT: "",
    });
    expect(env.DATABASE_URL_DIRECT).toBeUndefined();
    expect(env.DATABASE_SSL_CA_PATH).toBeUndefined();
    expect(env.ADMIN_TOKEN).toBeUndefined();
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.PORT).toBe(3000);
  });

  it("still rejects values that are set but wrong", () => {
    expect(() => loadEnv({ ...base, DATABASE_URL_DIRECT: "not a url" })).toThrow(
      /DATABASE_URL_DIRECT/,
    );
    expect(() => loadEnv({ ...base, ADMIN_TOKEN: "short" })).toThrow(/ADMIN_TOKEN/);
  });

  it("requires DATABASE_URL", () => {
    expect(() => loadEnv({ DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });
});
