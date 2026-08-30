import { readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MockBinCleanup } from "./mock-bin.js";
import type { MockBehaviourScript } from "./mock-bin-behaviour-runtime.js";

// Test-side half of the scripted-behaviour convention: it compiles a
// MockBinBehaviour into the tiny node mock that mock-bin installs, and
// reads back the invocations that mock recorded. The behaviour itself
// runs in the mocked binary's process — see mock-bin-behaviour-runtime.

/** Default life of a mock kept alive on purpose, and of its child. */
const LIFETIME_MS = 120_000;

/** Default budget of `handle.waitForCall`, and how often it polls. */
const WAIT_TIMEOUT_MS = 5_000;
const WAIT_POLL_MS = 50;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
   * Resolves with the first recorded invocation for which `predicate`
   * returns true, polling `calls` every 50ms until it appears. Omit
   * the predicate to wait for any invocation. Rejects once `timeoutMs`
   * (default 5000) passes without a match, listing the invocations
   * recorded so far; once the mock is cleaned up the frozen snapshot
   * is consulted, and a miss rejects at once — no new invocation can
   * arrive after teardown.
   */
  readonly waitForCall: (
    predicate?: (call: MockBinCall) => boolean,
    timeoutMs?: number,
  ) => Promise<MockBinCall>;
};

// The runtime twin ships next to this module: the .js build in the
// published package, the .ts source when tests run from source (node
// strips the types in the spawned mock process).
const ownPath = fileURLToPath(import.meta.url);
const runtimeUrl = pathToFileURL(
  path.join(
    path.dirname(ownPath),
    `mock-bin-behaviour-runtime${path.extname(ownPath)}`,
  ),
).href;

const toLines = (value: string | readonly string[] | undefined): string[] => {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : [...value];
};

const toLifetimeMs = (
  option: boolean | MockBinLifetimeOptions | undefined,
): number | undefined => {
  if (option === undefined || option === false) return undefined;
  if (option === true) return LIFETIME_MS;
  return option.lifetimeMs ?? LIFETIME_MS;
};

/**
 * Builds the mock script: a bootstrap that imports the runtime twin by
 * absolute URL and hands it the scripted behaviour. Keeping the logic
 * in a real module — rather than generating it as source — leaves it
 * type-checked and linted, and the dynamic import runs the same from
 * the extensionless POSIX mock and the Windows `.cjs` shim entry, both
 * of which node parses as CommonJS.
 */
const bootstrapCode = (script: MockBehaviourScript): string =>
  `import(${JSON.stringify(runtimeUrl)}).then((runtime) =>\n` +
  `  runtime.runMockBehaviour(${JSON.stringify(script)}),\n);\n`;

/**
 * Compiles a behaviour into the mock's script, creating the directory
 * its invocations are recorded into when recording is on.
 */
const prepareBehaviour = async (
  binName: string,
  pattern: string | undefined,
  behaviour: MockBinBehaviour,
): Promise<{ code: string; recordDir: string | undefined }> => {
  const record = behaviour.record ?? true;
  const recordDir =
    record === false
      ? undefined
      : await mkdtemp(path.join(tmpdir(), "type-a-bin-calls-"));
  const spawnChildMs = toLifetimeMs(behaviour.spawnChild);
  const trapSignalsMs = toLifetimeMs(behaviour.trapSignals);
  const script: MockBehaviourScript = {
    binName,
    stdout: toLines(behaviour.stdout),
    stderr: toLines(behaviour.stderr),
    exitCode: behaviour.exitCode ?? 0,
    delayMs: behaviour.delayMs ?? 0,
    lineDelayMs: behaviour.lineDelayMs ?? 0,
    recordStdin: typeof record === "object" && record.stdin === true,
    ...(pattern === undefined ? {} : { pattern }),
    ...(recordDir === undefined ? {} : { recordDir }),
    ...(spawnChildMs === undefined ? {} : { spawnChildMs }),
    ...(trapSignalsMs === undefined ? {} : { trapSignalsMs }),
  };
  return { code: bootstrapCode(script), recordDir };
};

/**
 * Parses one record, tolerating the states a writer running
 * concurrently with the read can leave behind: a slot the runtime has
 * claimed but not yet published reads as empty, and a truncated file
 * cannot parse. Publishing is by atomic rename, so the latter "cannot
 * happen" — reading it as absent anyway keeps the polling reader safe
 * if that protocol ever loosens, instead of crashing mid-wait.
 */
const parseRecord = (file: string): MockBinCall | undefined => {
  const content = readFileSync(file, "utf-8");
  if (content === "") return undefined;
  try {
    return JSON.parse(content) as MockBinCall;
  } catch {
    return undefined;
  }
};

/**
 * Reads the recorded invocations in the order the mock was called: the
 * runtime numbers each record as it claims a slot. The `.json` suffix
 * filters out records still being written to their `.pending` sidecar,
 * and a slot caught mid-write is skipped until its record lands.
 */
const readCalls = (recordDir: string): MockBinCall[] =>
  readdirSync(recordDir)
    .filter((name) => name.endsWith(".json"))
    .sort(
      (left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10),
    )
    .flatMap((name) => {
      const record = parseRecord(path.join(recordDir, name));
      return record === undefined ? [] : [record];
    });

/**
 * Turns a cleanup function into the handle a scripted behaviour
 * returns. Cleanup snapshots the recorded calls before removing the
 * record directory, so assertions still read after teardown.
 */
const withCalls = (
  cleanup: MockBinCleanup,
  recordDir: string | undefined,
): MockBinHandle => {
  let snapshot: MockBinCall[] | undefined;
  const handle = (): void => {
    if (snapshot === undefined && recordDir !== undefined)
      snapshot = readCalls(recordDir);
    cleanup();
    if (recordDir !== undefined)
      // Windows can transiently deny deleting a file a just-exited mock
      // still holds, so the removal retries like mock-bin's own.
      rmSync(recordDir, {
        recursive: true,
        force: true,
        maxRetries: 40,
        retryDelay: 250,
      });
  };
  // The one read both the `calls` getter and `waitForCall` poll: the
  // snapshot once cleanup has frozen it, a fresh (mid-write-safe)
  // reading of the record directory before that.
  const currentCalls = (): MockBinCall[] => {
    if (snapshot !== undefined) return snapshot;
    return recordDir === undefined ? [] : readCalls(recordDir);
  };
  Object.defineProperty(handle, "calls", {
    enumerable: true,
    get: currentCalls,
  });
  const describeRecorded = (): string => {
    const calls = currentCalls();
    return calls.length === 0
      ? "none"
      : calls.map((call) => JSON.stringify(call.args)).join(", ");
  };
  const waitForCall = async (
    predicate?: (call: MockBinCall) => boolean,
    timeoutMs?: number,
  ): Promise<MockBinCall> => {
    if (recordDir === undefined)
      throw new Error(
        "waitForCall: the behaviour records nothing, so no invocation " +
          "can ever match",
      );
    const matches = predicate ?? ((): boolean => true);
    const budgetMs = timeoutMs ?? WAIT_TIMEOUT_MS;
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const match = currentCalls().find(matches);
      if (match !== undefined) return match;
      // Cleanup freezes the records at their snapshot, so a miss can
      // never turn into a hit — fail at once instead of burning the
      // budget waiting for an invocation that cannot arrive.
      if (snapshot !== undefined)
        throw new Error(
          "waitForCall: no invocation matched, and the mock is already " +
            `cleaned up — calls recorded: ${describeRecorded()}`,
        );
      if (Date.now() >= deadline) break;
      await sleep(WAIT_POLL_MS);
    }
    throw new Error(
      "waitForCall: no invocation matched within " +
        `${budgetMs}ms — calls recorded so far: ${describeRecorded()}`,
    );
  };
  Object.defineProperty(handle, "waitForCall", {
    enumerable: true,
    value: waitForCall,
  });
  return handle as MockBinHandle;
};

export {
  type MockBinBehaviour,
  type MockBinCall,
  type MockBinHandle,
  type MockBinLifetimeOptions,
  type MockBinRecordOptions,
  prepareBehaviour,
  withCalls,
};
