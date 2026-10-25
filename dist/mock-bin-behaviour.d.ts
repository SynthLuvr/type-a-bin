import type { MockBinCleanup } from "./mock-bin.js";
interface MockBinRecordOptions {
    /**
     * Read stdin to end-of-file and record it as `call.stdin`. Off by
     * default: a mock that drains stdin waits for the caller to close it.
     */
    stdin?: boolean;
}
interface MockBinLifetimeOptions {
    /** How long to stay alive before exiting, in ms. Default 120000. */
    lifetimeMs?: number;
}
interface MockBinBehaviour {
    /**
     * Record every invocation for `handle.calls`. On by default; pass
     * `false` to skip recording, or `{ stdin: true }` to capture stdin
     * as well.
     */
    record?: boolean | MockBinRecordOptions;
    /** Line(s) written to stdout, each followed by a newline. */
    stdout?: string | readonly string[];
    /** Line(s) written to stderr, after the stdout lines. */
    stderr?: string | readonly string[];
    /** Exit code the mock finishes with. Default 0. */
    exitCode?: number;
    /** Delay before the mock writes anything, in milliseconds. */
    delayMs?: number;
    /**
     * Gap between stdout lines, in milliseconds, so a consumer tailing
     * the stream sees them arrive one at a time instead of in one burst.
     */
    lineDelayMs?: number;
    /**
     * Spawn a long-lived descendant in the mock's process group and
     * record its pid as `call.childPid`, so a test can prove a stop reaps
     * the whole process tree rather than the mock alone.
     */
    spawnChild?: boolean | MockBinLifetimeOptions;
    /**
     * Ignore SIGINT and SIGTERM, so stopping the mock has to escalate to
     * SIGKILL. The mock then runs until it is killed, or until its
     * lifetime runs out — the bound keeps a mock a test forgets to stop
     * from outliving the suite.
     */
    trapSignals?: boolean | MockBinLifetimeOptions;
}
interface MockBinCall {
    /** Arguments the mock was invoked with, excluding the binary name. */
    args: string[];
    /** Working directory the mock ran in. */
    cwd: string;
    /** Environment the mock ran with. */
    env: Record<string, string>;
    /** Process id of the mock itself. */
    pid: number;
    /** Stdin, when the behaviour recorded it. */
    stdin?: string;
    /** Pid of the descendant, when the behaviour spawned one. */
    childPid?: number;
}
/**
 * The cleanup function every `mockBin` call returns, carrying the
 * invocations a scripted behaviour recorded. `calls` is read fresh on
 * every access — a still-running mock shows up as soon as it has been
 * recorded — and keeps serving the last reading after cleanup.
 * `waitForCall` bridges the gap to asynchronous callers: a mock is
 * invoked by another process, so its record lands some time after the
 * spawn that caused it.
 */
type MockBinHandle = MockBinCleanup & {
    readonly calls: MockBinCall[];
    /**
     * Resolves with the first recorded invocation matching the
     * predicate, polling until it appears; rejects after `timeoutMs`
     * (default 5000) with the invocations recorded so far. Omit the
     * predicate to wait for any invocation.
     */
    readonly waitForCall: (predicate?: (call: MockBinCall) => boolean, timeoutMs?: number) => Promise<MockBinCall>;
};
/**
 * Compiles a behaviour into the mock's script, creating the directory
 * its invocations are recorded into when recording is on.
 */
declare const prepareBehaviour: (binName: string, pattern: string | undefined, behaviour: MockBinBehaviour) => Promise<{
    code: string;
    recordDir: string | undefined;
}>;
/**
 * Turns a cleanup function into the handle a scripted behaviour
 * returns. Cleanup snapshots the recorded calls before removing the
 * record directory, so assertions still read after teardown.
 */
declare const withCalls: (cleanup: MockBinCleanup, recordDir: string | undefined) => MockBinHandle;
export { type MockBinBehaviour, type MockBinCall, type MockBinHandle, type MockBinLifetimeOptions, type MockBinRecordOptions, prepareBehaviour, withCalls, };
