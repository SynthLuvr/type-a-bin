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
 * @param binNameOrConfig - Binary name or a config object with `binName`
 *   and an optional `pattern`
 * @param shebang - Interpreter to use (e.g., "bash", "node", "python")
 * @param code - Script code to execute when the mock binary is called
 * @returns A cleanup function that restores the original PATH
 *
 * @example
 * ```ts
 * const cleanup = await mockBin("gh", "bash", 'echo "mocked!!"')
 * // ... run your tests ...
 * cleanup() // Restore original PATH
 * ```
 */
declare const mockBin: (binNameOrConfig: string | MockBinConfig, shebang: string, code: string) => Promise<MockBinCleanup>;
export { type MockBinCleanup, type MockBinConfig, mockBin };
