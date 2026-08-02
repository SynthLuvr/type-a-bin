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
 * There are three calling conventions:
 *
 * 1. **Output shorthand** — pass the plain text the mock should print.
 *    The interpreter defaults to `bash` and the output is echoed.
 * 2. **Full script** — pass an interpreter (`shebang`) and arbitrary
 *    script `code` to run when the mock binary is invoked.
 * 3. **Script file** — pass an interpreter (`shebang`) and a
 *    `{ file }` object pointing at a script on disk. The file keeps its
 *    own extension, so extension-aware loaders work (e.g.
 *    `node --import tsx` with a `.ts` file).
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
 * // Script file (keeps its extension, so tsx transforms it)
 * const cleanup = await mockBin("dragon", "node --import tsx", {
 *   file: "./src/tests/hoard-script.ts",
 * })
 * ```
 */
declare function mockBin(binNameOrConfig: string | MockBinConfig, output: string): Promise<MockBinCleanup>;
declare function mockBin(binNameOrConfig: string | MockBinConfig, shebang: string, code: string): Promise<MockBinCleanup>;
declare function mockBin(binNameOrConfig: string | MockBinConfig, shebang: string, script: MockBinScriptFile): Promise<MockBinCleanup>;
export { type MockBinCleanup, type MockBinConfig, type MockBinScriptFile, mockBin, };
