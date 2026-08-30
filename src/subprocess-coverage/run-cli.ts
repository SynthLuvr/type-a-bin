import process from "node:process";
import { fileURLToPath } from "node:url";
import { runNodeEntryAsMain } from "../mock-bin-runtime.js";
import { isTypeScriptFile, resolveTsxImportUrl } from "../mock-bin-tsx.js";

// The launcher entry-point for projects that wrap a CLI entry in
// bin/*.mjs: everything such a launcher used to hand-roll from the
// README — argv repositioning, tsx resolution, the restart-versus-
// in-process decision, the ordered tsx → observer → entry import
// chain — folded into one call on top of the same machinery mockBin
// dispatch uses (runNodeEntryAsMain). Like mock-bin-runtime, this
// module loads in a process the library does not control (the
// consumer's own CLI, possibly outside any test run), so it may
// import nothing beyond node's own modules and the node-only helpers
// beside it — never merge.js, whose vitest and istanbul imports would
// crash a launcher in a tree without the coverage toolchain.

/**
 * Runs a CLI entry as this process's main module — the whole launcher
 * shape a project's `bin/*.mjs` needs.
 *
 * Captures `process.argv.slice(2)`, repositions argv to
 * `[node, entry, ...args]` so the entry reads its CLI arguments at
 * `process.argv.slice(2)` like a script node started directly, and
 * loads the entry exactly the way type-a-bin loads its own node-kind
 * mocks: a `.cjs` entry through `Module._load` with `isMain` set, any
 * other entry as ESM with the tsx loader imported first when the entry
 * is TypeScript (resolved from the entry's own package; node's native
 * type stripping covers projects without tsx). While
 * `TYPE_A_BIN_SUBPROCESS_COVERAGE_DIR` is set the observer joins
 * ordered above the loader: an inherited `NODE_OPTIONS` hook entry
 * forces a restart with `--import tsx --import observer entry` on a
 * scrubbed `NODE_OPTIONS`, and without one the observer imports
 * in-process right after tsx. With propagation off, no coverage
 * machinery loads at all.
 *
 * The returned promise settles when the entry's top level finishes;
 * the process then exits with whatever exit code the entry set.
 */
const runCliAsMain = async (entry: string | URL): Promise<void> => {
  const entryPath = typeof entry === "string" ? entry : fileURLToPath(entry);
  // The launcher itself sits in argv[1]; everything after it is the
  // caller's command line, captured before runNodeEntryAsMain moves
  // the entry into argv[1].
  const cliArgs = process.argv.slice(2);
  const tsxImportUrl = isTypeScriptFile(entryPath)
    ? (resolveTsxImportUrl(entryPath) ?? undefined)
    : undefined;
  return runNodeEntryAsMain(entryPath, cliArgs, tsxImportUrl);
};

export { runCliAsMain };
