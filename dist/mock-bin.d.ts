interface MockBinCleanup {
    (): void;
}
interface MockBinConfig {
    /** The name of the binary to mock (e.g., "gh", "git") */
    binName: string;
    /** Optional regex pattern. Only commands matching it are mocked. */
    pattern?: string;
}
/**
 * Creates a mock executable that replaces a real binary on the PATH.
 *
 * The mock script can call `mock-a-bin-run-original` to execute the
 * original command, enabling conditional mocking where some subcommands
 * are mocked while others pass through to the real binary.
 *
 * There are two calling conventions:
 *
 * 1. **Output shorthand** — pass the plain text the mock should print.
 *    The interpreter defaults to `bash` and the output is echoed.
 * 2. **Full script** — pass an interpreter (`shebang`) and arbitrary
 *    script `code` to run when the mock binary is invoked.
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
 */
type MockBin = {
    (binNameOrConfig: string | MockBinConfig, output: string): Promise<MockBinCleanup>;
    (binNameOrConfig: string | MockBinConfig, shebang: string, code: string): Promise<MockBinCleanup>;
};
declare const mockBin: MockBin;
export { type MockBinCleanup, type MockBinConfig, mockBin };
