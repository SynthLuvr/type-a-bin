#!/usr/bin/env tsx
// Runs vitest with subprocess coverage propagation enabled for
// `pnpm test:lib`. The env vars opt the custom provider configured in
// vitest.config.ts in: the runner's environment points at a shared
// raw-profile directory and loads the observer hook, which every Node
// child that inherits the environment picks up — the provider merges
// the result into the report (see src/subprocess-coverage/merge.ts).
// A bare `vitest run` without this wrapper behaves exactly as before.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const vitestEntry = join(ROOT, "node_modules", "vitest", "vitest.mjs");

const result = spawnSync(
  process.execPath,
  [vitestEntry, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      TYPE_A_BIN_SUBPROCESS_COVERAGE_DIR: join(ROOT, "coverage", ".v8-raw"),
      TYPE_A_BIN_SUBPROCESS_COVERAGE_ROOTS: join(ROOT, "src"),
    },
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
