#!/usr/bin/env tsx
/**
 * Fails `pnpm lint` when the installed tree has unmet or missing peer
 * dependencies.
 *
 *   pnpm lint:peer-deps -> tsx scripts/peer-deps.mts
 *
 * pnpm is spawned via `npm_execpath` rather than by bare name: the `pnpm` on
 * PATH is a `.cmd` shim on Windows, which needs `shell: true` to spawn and is
 * blocked outright by AppLocker on managed hosts. `npm_execpath` is pnpm's
 * real entry point — the JS file when pnpm is installed via npm/corepack (run
 * under node), or the native executable itself for standalone (`@pnpm/exe`)
 * installs — so neither a shim nor a shell is involved.
 *
 * Uses `pnpm peers check` (which inspects the lockfile directly) rather than
 * `install --strict-peer-dependencies`: a frozen lockfile is not re-resolved
 * during install, so the strict flag silently misses pre-existing peer
 * conflicts.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const checkPeerDependencies = (): void => {
  const pnpmEntry = process.env.npm_execpath;
  if (pnpmEntry === undefined)
    throw new Error(
      "npm_execpath is unset — run this via `pnpm lint:peer-deps`.",
    );

  // `node <entry>` only works when the entry is JS; the standalone
  // executable is spawned directly (no shell, no shim, on any platform).
  const isJs = /\.(?:js|cjs|mjs)$/.test(pnpmEntry);
  const result = spawnSync(
    isJs ? process.execPath : pnpmEntry,
    isJs ? [pnpmEntry, "peers", "check"] : ["peers", "check"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );

  if (result.error) throw result.error;

  if (result.status === 0) {
    console.log("No peer dependency issues found.");
    return;
  }

  const detail = `${result.stdout}${result.stderr}`.trim();
  throw new Error(
    `Peer dependency issues found after \`pnpm install\`.` +
      `${detail ? `\n\n${detail}\n` : ""}` +
      "\nResolve the conflicts above, then re-run `pnpm install`.",
  );
};

try {
  checkPeerDependencies();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
