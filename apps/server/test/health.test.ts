import "reflect-metadata";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { DB } from "../src/db/db";
import { HealthController } from "../src/health/health.controller";

describe("health endpoints", () => {
  let app: NestFastifyApplication | undefined;

  const start = async (execute: () => Promise<unknown>) => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: DB, useValue: { execute } }],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  };

  afterEach(async () => {
    await app?.close();
  });

  it("healthz is ok without touching the database", async () => {
    const a = await start(() => Promise.reject(new Error("down")));
    const res = await a.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("readyz reflects the database", async () => {
    expect(
      (await (await start(async () => ({}))).inject({ method: "GET", url: "/readyz" })).statusCode,
    ).toBe(200);
    await app?.close();
    const down = await start(() => Promise.reject(new Error("down")));
    expect((await down.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
  });
});
