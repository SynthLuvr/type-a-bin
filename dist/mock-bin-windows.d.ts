import type { MockBinScriptFile } from "./mock-bin.js";
/**
 * Windows implementation of `mockBin`; see mock-bin.ts for the public
 * overloads. By default it installs copies of the trampoline launcher
 * as `<binName>.exe` and the `mock-a-bin-run-original.exe` helper plus
 * a generated bootstrap into a temp directory prepended to PATH, and
 * registers the mock in the dispatch registry. Setting
 * TYPE_A_BIN_DISABLE_TRAMPOLINE=1 (or a missing launcher) falls back to
 * the legacy node.exe hard links with the NODE_OPTIONS preload.
 */
declare const mockBinWindows: (binName: string, pattern: string | undefined, shebangOrOutput: string, codeOrScript: string | MockBinScriptFile | undefined) => Promise<() => void>;
export { mockBinWindows };
