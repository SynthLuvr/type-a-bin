import process from "node:process";

// Leaf module for the pieces of subprocess coverage the core mockBin
// path needs: the observer hook's URL, the opt-in env var, and the
// NODE_OPTIONS surgery that keeps the hook loadable exactly once, in
// the right position. Free of the merge pipeline's dependencies
// (vitest, istanbul, ast-v8-to-istanbul) so mockBin can order the
// observer for its TypeScript mocks without dragging any of that into
// the core package. mock-bin-runtime keeps its own copies of these —
// it executes inside child processes and cannot import library
// modules — so changes here must be mirrored there.

/** Opt-in env var naming the raw-profile directory. */
const RAW_COVERAGE_ENV = "TYPE_A_BIN_SUBPROCESS_COVERAGE_DIR";

/** Absolute file URL of the observer hook shipped next to this module. */
const coverageHookUrl = (): string =>
  new URL("./coverage-hook.mjs", import.meta.url).href;

/** True when subprocess coverage propagation is switched on. */
const subprocessCoverageEnabled = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const dir = env[RAW_COVERAGE_ENV];
  return dir !== undefined && dir !== "";
};

/**
 * Removes the observer hook's `--import` entry from a NODE_OPTIONS
 * value (both `--import <url>` and `--import=<url>`), leaving every
 * other option untouched.
 *
 * Children that load the hook explicitly after their loaders must also
 * drop an inherited entry: NODE_OPTIONS is processed before argv
 * `--import`, and the hook module registers its loader only once, so an
 * inherited entry would win the registration and sit below every
 * loader in the LIFO hook chain — recording pre-transform source
 * against transpiled coverage offsets.
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

export {
  coverageHookUrl,
  RAW_COVERAGE_ENV,
  stripCoverageHookFromNodeOptions,
  subprocessCoverageEnabled,
};
