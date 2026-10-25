import process from "node:process";
import { fileURLToPath } from "node:url";
import { runNodeEntryAsMain } from "../mock-bin-runtime.js";
import { isTypeScriptFile, resolveTsxImportUrl } from "../mock-bin-tsx.js";
// Like mock-bin-runtime, this module runs in a process the library
// does not control — a consumer's own CLI, possibly outside any test
// run — so it may import nothing beyond node's own modules and the
// node-only helpers beside it: merge.js imports vitest and istanbul
// machinery that would crash a launcher in a tree without the
// coverage toolchain.
/**
 * Runs a CLI entry as this process's main module — the whole launcher
 * shape a project's `bin/*.mjs` needs under subprocess coverage. The
 * entry loads exactly the way type-a-bin loads its own node-kind
 * mocks: a `.cjs` entry through `Module._load` with `require.main`
 * set, anything else as ESM, tsx first when the entry is TypeScript
 * (resolved from the entry's own package; node's native type
 * stripping covers projects without tsx). While
 * `TYPE_A_BIN_SUBPROCESS_COVERAGE_DIR` is set the observer joins
 * ordered above the loader — an inherited `NODE_OPTIONS` hook entry
 * forces a restart on a scrubbed `NODE_OPTIONS`, otherwise the
 * observer imports in-process right after tsx. With propagation off,
 * no coverage machinery loads at all.
 *
 * The returned promise settles when the entry's top level finishes;
 * the process then exits with whatever exit code the entry set.
 */
const runCliAsMain = async (entry) => {
    const entryPath = typeof entry === "string" ? entry : fileURLToPath(entry);
    // Captured before runNodeEntryAsMain repositions argv around the
    // entry.
    const cliArgs = process.argv.slice(2);
    const tsxImportUrl = isTypeScriptFile(entryPath)
        ? (resolveTsxImportUrl(entryPath) ?? undefined)
        : undefined;
    return runNodeEntryAsMain(entryPath, cliArgs, tsxImportUrl);
};
export { runCliAsMain };
