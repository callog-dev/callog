import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// esbuild cannot emit decorator metadata, which Nest DI relies on.
const plugins = [swc.vite({ module: { type: "es6" } })];

export default defineConfig({
  test: {
    projects: [
      {
        plugins,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: ["**/*.int.test.ts"],
        },
      },
      {
        plugins,
        test: {
          name: "int",
          include: ["test/**/*.int.test.ts"],
          globalSetup: ["test/setup/int-global-setup.ts"],
          // Tests share one database.
          fileParallelism: false,
          // Worker-backed tests wait for real queue processing.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
