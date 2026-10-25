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
declare const runCliAsMain: (entry: string | URL) => Promise<void>;
export { runCliAsMain };
