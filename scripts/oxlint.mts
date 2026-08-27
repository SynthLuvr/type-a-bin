#!/usr/bin/env tsx
/**
 * Runs oxlint with `OXLINT_TSGOLINT_PATH` pointed at the real tsgolint
 * executable.
 *
 *   pnpm lint:oxlint -> tsx scripts/oxlint.mts --deny-warnings .
 *
 * oxlint's type-aware rules shell out to tsgolint, and on Windows it prefers
 * the `node_modules/.bin/tsgolint.CMD` shim over the platform binary. Batch
 * files under the user profile are blocked outright on AppLocker-managed
 * Windows hosts, so resolve the platform binary here and hand oxlint an
 * absolute path. `OXLINT_TSGOLINT_PATH` is honoured on every platform, so this
 * needs no per-OS branching beyond the executable's name.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** Absolute path to oxlint's own CLI entry point, read from its `bin` field. */
const oxlintCli = (): string => {
  const manifest = require.resolve("oxlint/package.json");
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as {
    bin: Record<string, string>;
  };
  return join(dirname(manifest), bin.oxlint);
};

/**
 * Absolute path to the tsgolint executable, or `undefined` when this platform
 * has no prebuilt binary — in which case oxlint falls back to its own lookup
 * and reports the missing package itself.
 */
const tsgolintExe = (): string | undefined => {
  const name = process.platform === "win32" ? "tsgolint.exe" : "tsgolint";
  const target = `@oxlint-tsgolint/${process.platform}-${process.arch}/${name}`;
  try {
    // Resolve from oxlint-tsgolint, which declares the per-platform packages;
    // they are not direct dependencies of this project.
    const tsgolint = require.resolve("oxlint-tsgolint/package.json");
    return createRequire(tsgolint).resolve(target);
  } catch {
    return undefined;
  }
};

const exe = tsgolintExe();
if (exe !== undefined) process.env.OXLINT_TSGOLINT_PATH = exe;

// The CLI entry point lints on import and reads `process.argv.slice(2)`, which
// is already the argument list this script was given.
await import(pathToFileURL(oxlintCli()).href);
