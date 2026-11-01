import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { staticFileOptions } from "./static";

describe("staticFileOptions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "callog-web-"));
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "assets", "index-abc123.js"), "");
  writeFileSync(path.join(root, "favicon.svg"), "<svg/>");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const serve = async (url: string) => {
    const app = Fastify();
    await app.register(fastifyStatic, { root, wildcard: false, ...staticFileOptions(root) });
    const res = await app.inject(url);
    await app.close();
    return res;
  };

  it("caches hashed assets forever", async () => {
    const res = await serve("/assets/index-abc123.js");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("revalidates files whose names do not change", async () => {
    expect((await serve("/favicon.svg")).headers["cache-control"]).toBe("no-cache");
  });
});
