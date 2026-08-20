#!/usr/bin/env tsx
/**
 * Fails `pnpm lint` when the installed tree has unmet or missing peer
 * dependencies.
 *
 *   pnpm lint:peer-deps -> tsx scripts/peer-deps.mts
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

// npm_execpath (set while running under a pnpm script) may be a
// standalone binary node cannot load, so hand it to node only when it
// is a JavaScript file — e.g. npm-installed pnpm, whose Windows .cmd
// shim spawnSync cannot execute — and otherwise run "pnpm" off PATH.
const isJsEntry = (path: string): boolean => /\.(?:c|m)?js$/u.test(path);

const runPnpm = (args: string[]) => {
  const entry = process.env.npm_execpath;
  const options = { cwd: ROOT, encoding: "utf8" } as const;
  if (entry !== undefined && isJsEntry(entry))
    return spawnSync(process.execPath, [entry, ...args], options);
  return spawnSync("pnpm", args, options);
};

const checkPeerDependencies = (): void => {
  const result = runPnpm(["peers", "check"]);
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
