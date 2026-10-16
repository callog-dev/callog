import { Global, Module } from "@nestjs/common";
import { ENV, type Env } from "../config/env";
import { SecretBox } from "./secret-box";

export const SECRET_BOX = Symbol("SECRET_BOX");

/** Provides `SecretBox | undefined` (undefined when ENCRYPTION_KEY is not set). */
@Global()
@Module({
  providers: [
    {
      provide: SECRET_BOX,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.ENCRYPTION_KEY ? new SecretBox(env.ENCRYPTION_KEY) : undefined,
    },
  ],
  exports: [SECRET_BOX],
})
export class CryptoModule {}
