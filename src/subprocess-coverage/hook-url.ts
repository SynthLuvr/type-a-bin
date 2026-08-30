const RAW_COVERAGE_ENV = "TYPE_A_BIN_SUBPROCESS_COVERAGE_DIR";

/**
 * Absolute file URL of the observer hook shipped next to this module.
 *
 * This leaf module exists so the core mockBin path can order the
 * observer for its TypeScript mocks without importing the merge
 * pipeline's dependencies (vitest, istanbul, ast-v8-to-istanbul).
 * mock-bin-runtime.ts runs inside child processes and cannot import
 * library modules, so it mirrors these definitions — keep the two in
 * sync.
 */
const coverageHookUrl = (): string =>
  new URL("./coverage-hook.mjs", import.meta.url).href;

/**
 * Removes the observer hook's `--import` entry (both `--import <url>`
 * and `--import=<url>`) from a NODE_OPTIONS value, leaving every other
 * option untouched.
 *
 * Children that load the hook explicitly after their loaders must also
 * drop an inherited entry: NODE_OPTIONS is processed before argv
 * `--import`, and the hook module registers its loader only once, so
 * the inherited entry would register ahead of the loaders and sit
 * below them in the LIFO registerHooks chain — recording pre-transform
 * source against transpiled coverage offsets.
 */
const stripCoverageHookFromNodeOptions = (nodeOptions: string): string => {
  const hook = coverageHookUrl();
  const tokens = nodeOptions.split(" ").filter((token) => token !== "");
  return tokens
    .filter(
      (token, index) =>
        token !== hook &&
        token !== `--import=${hook}` &&
        !(token === "--import" && tokens[index + 1] === hook),
    )
    .join(" ");
};

export { coverageHookUrl, RAW_COVERAGE_ENV, stripCoverageHookFromNodeOptions };
