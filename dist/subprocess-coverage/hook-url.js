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
const coverageHookUrl = () => new URL("./coverage-hook.mjs", import.meta.url).href;
const nodeOptionTokens = (nodeOptions) => nodeOptions.split(" ").filter((token) => token !== "");
// Whether tokens[index] belongs to the observer's --import entry: the
// flag of a spaced pair, the `--import=<url>` form, or the bare URL
// such a pair leaves behind when the flag is removed.
const isHookImportToken = (hook, tokens, index) => tokens[index] === hook ||
    tokens[index] === `--import=${hook}` ||
    (tokens[index] === "--import" && tokens[index + 1] === hook);
/**
 * Whether a NODE_OPTIONS value loads the observer hook at startup.
 *
 * A true answer means node registered the observer ahead of any loader
 * a launcher imports in-process — the ordering only an ordered restart
 * can undo. A false answer means no startup registration exists, so
 * the launcher can import the observer itself, after its loaders,
 * without a second process.
 */
const hookPresentInNodeOptions = (nodeOptions) => {
    const hook = coverageHookUrl();
    const tokens = nodeOptionTokens(nodeOptions);
    return tokens.some((_, index) => isHookImportToken(hook, tokens, index));
};
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
const stripCoverageHookFromNodeOptions = (nodeOptions) => {
    const hook = coverageHookUrl();
    const tokens = nodeOptionTokens(nodeOptions);
    return tokens
        .filter((_, index) => !isHookImportToken(hook, tokens, index))
        .join(" ");
};
export { coverageHookUrl, hookPresentInNodeOptions, RAW_COVERAGE_ENV, stripCoverageHookFromNodeOptions, };
