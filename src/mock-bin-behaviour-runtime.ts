import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  openSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import type { MockBinCall } from "./mock-bin-behaviour.js";

// Runs inside the mocked binary's own process — spawned on POSIX, in
// the shim on Windows — so it must stay free of runtime imports beyond
// node's own modules. mock-bin-behaviour compiles a MockBinBehaviour
// into the script below and the mock hands it straight back here.
// The registry env var must stay in sync with mock-bin-windows.
const MOCKS_VAR = "TYPE_A_BIN_MOCKS";

const WINDOWS_EXTENSIONS = ["", ".exe", ".cmd", ".bat", ".com"];

interface MockBehaviourScript {
  /** Name of the binary being mocked, as the pattern sees it. */
  binName: string;
  /** Lines written to stdout, each followed by a newline. */
  stdout: string[];
  /** Lines written to stderr, after the stdout lines. */
  stderr: string[];
  /** Exit code the mock finishes with. */
  exitCode: number;
  /** Delay before the mock writes anything, in milliseconds. */
  delayMs: number;
  /** Gap between stdout lines, in milliseconds. */
  lineDelayMs: number;
  /** Read stdin to end-of-file and record it. */
  recordStdin: boolean;
  /** Regex source; only matching commands run the behaviour. */
  pattern?: string;
  /** Directory that receives one JSON record per invocation. */
  recordDir?: string;
  /** Life of the spawned descendant; absent means spawn none. */
  spawnChildMs?: number;
  /** How long trapped signals keep the mock alive; absent traps none. */
  trapSignalsMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isFile = (candidate: string): boolean => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/** The PATH without the mock temp dirs, so the real binary wins. */
const realBinary = (binName: string): string | null => {
  const dirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => dir !== "" && !dir.includes("mock-bin-"));
  const extensions = process.platform === "win32" ? WINDOWS_EXTENSIONS : [""];
  for (const dir of dirs)
    for (const extension of extensions) {
      const candidate = path.join(dir, `${binName}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  return null;
};

/**
 * Pattern miss: hand the invocation to the binary the mock shadows.
 * The behaviour tests the pattern itself rather than leaning on the
 * wrappers the other conventions use, because those are shell scripts
 * and this mock is a node one on both platforms.
 */
const runRealBinary = (binName: string, args: string[]): void => {
  const real = realBinary(binName);
  if (real === null) {
    process.stderr.write(`Error: Real binary '${binName}' not found in PATH\n`);
    process.exitCode = 127;
    return;
  }
  // The real binary must not be re-intercepted by the Windows preload.
  const env = { ...process.env };
  delete env[MOCKS_VAR];
  const result = spawnSync(real, args, { stdio: "inherit", env });
  process.exitCode = result.status ?? 127;
};

/**
 * Claims the next free record slot. Creating the file exclusively makes
 * the number a race-free ticket, so concurrent invocations are recorded
 * in the order they started.
 */
const reserveRecord = (recordDir: string): string => {
  for (let index = 0; ; index += 1) {
    const file = path.join(recordDir, `${index}.json`);
    try {
      closeSync(openSync(file, "wx"));
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
};

/** Publishes a record by rename, so a reader never sees half of one. */
const writeRecord = (file: string, call: MockBinCall): void => {
  const pending = `${file}.pending`;
  writeFileSync(pending, JSON.stringify(call));
  renameSync(pending, file);
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
};

/**
 * Spawns a descendant that outlives the mock's own work, so a test can
 * prove a stop reaps the process tree rather than the mock alone.
 */
const spawnChild = (lifetimeMs: number): number | undefined => {
  // A Windows mock binary is a hard link of node.exe, so the preload
  // registered through NODE_OPTIONS would redirect this child back into
  // the mock script — a fork chain of phantom mocks. Dropping the
  // registry from its env makes the preload inert there.
  const env = { ...process.env };
  delete env[MOCKS_VAR];
  const child = spawn(
    process.execPath,
    ["-e", `setTimeout(() => {}, ${lifetimeMs})`],
    {
      stdio: "ignore",
      env,
      // POSIX detaching would start a new session, moving the child out
      // of the mock's process group and out of a group signal's reach.
      // Windows is the opposite: a spawned child sits in a job that is
      // killed when the mock exits, so only there must it detach to
      // outlive the mock.
      ...(process.platform === "win32" ? { detached: true } : {}),
    },
  );
  // The child stays in the mock's process group, so a stop that signals
  // the group reaps it; unref keeps it from holding the mock open, and
  // its bounded life keeps a missed descendant from outliving the suite.
  child.unref();
  return child.pid;
};

/**
 * Stop-escalation tests need a mock that ignores the graceful signals:
 * no-op handlers swallow them, so the process survives until the
 * ladder's SIGKILL rung lands.
 */
const trapSignals = (lifetimeMs: number): void => {
  process.on("SIGINT", () => undefined);
  process.on("SIGTERM", () => undefined);
  // Signal listeners do not hold node's event loop open, so a bounded
  // timer keeps the mock running for the stop ladder to work against.
  setTimeout(() => undefined, lifetimeMs);
};

/** Runs one invocation of a mock built from a scripted behaviour. */
const runMockBehaviour = async (script: MockBehaviourScript): Promise<void> => {
  const args = process.argv.slice(2);
  const command = [script.binName, ...args].join(" ");
  if (script.pattern !== undefined && !new RegExp(script.pattern).test(command))
    return runRealBinary(script.binName, args);

  if (script.trapSignalsMs !== undefined) trapSignals(script.trapSignalsMs);
  // The slot is claimed before anything can block and published as soon
  // as the invocation is fully described, so a test can read the call
  // while a slow or streaming mock is still running.
  const record =
    script.recordDir === undefined
      ? undefined
      : reserveRecord(script.recordDir);
  const childPid =
    script.spawnChildMs === undefined
      ? undefined
      : spawnChild(script.spawnChildMs);
  const stdin = script.recordStdin ? await readStdin() : undefined;
  if (record !== undefined)
    writeRecord(record, {
      args,
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      pid: process.pid,
      ...(stdin === undefined ? {} : { stdin }),
      ...(childPid === undefined ? {} : { childPid }),
    });

  if (script.delayMs > 0) await sleep(script.delayMs);
  for (const [index, line] of script.stdout.entries()) {
    if (index > 0 && script.lineDelayMs > 0) await sleep(script.lineDelayMs);
    process.stdout.write(`${line}\n`);
  }
  for (const line of script.stderr) process.stderr.write(`${line}\n`);
  process.exitCode = script.exitCode;
};

export { type MockBehaviourScript, runMockBehaviour };
