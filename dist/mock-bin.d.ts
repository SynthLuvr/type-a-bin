import type { MockBinBehaviour, MockBinHandle } from "./mock-bin-behaviour.js";
type MockBinCleanup = () => void;
interface MockBinConfig {
    /** The name of the binary to mock (e.g., "gh", "git") */
    binName: string;
    /** Optional regex pattern. Only commands matching it are mocked. */
    pattern?: string;
}
interface MockBinScriptFile {
    /**
     * Script executed when the mock runs. The file keeps its real
     * extension, so extension-aware loaders (e.g. `node --import tsx`)
     * parse it — embedding the source inline fails because the mock
     * binary is written to an extensionless temp file.
     */
    file: string;
}
/**
 * Creates a mock executable that replaces a real binary on the PATH.
 *
 * The mock script can call `mock-a-bin-run-original` to execute the
 * original command, enabling conditional mocking where some subcommands
 * are mocked while others pass through to the real binary.
 *
 * There are five calling conventions:
 *
 * 1. **Output shorthand** — pass the plain text the mock should print.
 *    The interpreter defaults to `bash` and the output is echoed.
 * 2. **Full script** — pass an interpreter (`shebang`) and arbitrary
 *    script `code` to run when the mock binary is invoked.
 * 3. **Script-file shorthand** — pass only a `{ file }` object and the
 *    interpreter is picked from the file's extension: TypeScript runs
 *    through the tsx loader (resolved to an absolute URL so the mock
 *    works from any working directory), `.js` through node, and `.sh`
 *    through bash.
 * 4. **Script file** — pass an interpreter (`shebang`) and a
 *    `{ file }` object pointing at a script on disk. The file keeps its
 *    own extension, so extension-aware loaders work (e.g.
 *    `node --import tsx` with a `.ts` file).
 * 5. **Scripted behaviour** — pass a `MockBinBehaviour` object instead
 *    of a script. The mock records every invocation on the returned
 *    handle's `calls`, and the object scripts the output, exit code and
 *    timing without writing a script at all.
 *
 * @param binNameOrConfig - Binary name or a config object with `binName`
 *   and an optional `pattern`
 * @returns A cleanup function that restores the original PATH
 *
 * @example
 * ```ts
 * // Output shorthand
 * const cleanup = await mockBin("gh", "mocked!!")
 * ```
 *
 * @example
 * ```ts
 * // Full script
 * const cleanup = await mockBin("gh", "bash", 'echo "mocked!!"')
 * // ... run your tests ...
 * cleanup() // Restore original PATH
 * ```
 *
 * @example
 * ```ts
 * // Script-file shorthand (the extension picks the interpreter)
 * const cleanup = await mockBin("dragon", {
 *   file: "./src/tests/hoard-script.ts", // → node --import <absolute tsx>
 * })
 * ```
 *
 * @example
 * ```ts
 * // Script file with an explicit interpreter (keeps its extension)
 * const cleanup = await mockBin("dragon", "node --import tsx", {
 *   file: "./src/tests/hoard-script.ts",
 * })
 * ```
 *
 * @example
 * ```ts
 * // Scripted behaviour, with the invocations recorded
 * const mock = await mockBin("gh", { stdout: ["#1", "#2"], exitCode: 1 })
 * expect(mock.calls[0]?.args).toEqual(["pr", "list"])
 * mock() // The handle is the cleanup function
 * ```
 */
declare function mockBin(binNameOrConfig: string | MockBinConfig, output: string): Promise<MockBinCleanup>;
declare function mockBin(binNameOrConfig: string | MockBinConfig, script: MockBinScriptFile): Promise<MockBinCleanup>;
declare function mockBin(binNameOrConfig: string | MockBinConfig, behaviour: MockBinBehaviour): Promise<MockBinHandle>;
declare function mockBin(binNameOrConfig: string | MockBinConfig, shebang: string, code: string): Promise<MockBinCleanup>;
declare function mockBin(binNameOrConfig: string | MockBinConfig, shebang: string, script: MockBinScriptFile): Promise<MockBinCleanup>;
export { type MockBinCleanup, type MockBinConfig, type MockBinScriptFile, mockBin, };
