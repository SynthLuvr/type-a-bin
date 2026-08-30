import { readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// Test-side half of the scripted-behaviour convention: it compiles a
// MockBinBehaviour into the tiny node mock that mock-bin installs, and
// reads back the invocations that mock recorded. The behaviour itself
// runs in the mocked binary's process — see mock-bin-behaviour-runtime.
/** Default life of a mock kept alive on purpose, and of its child. */
const LIFETIME_MS = 120_000;
/** Default budget of `handle.waitForCall`, and how often it polls. */
const WAIT_TIMEOUT_MS = 5_000;
const WAIT_POLL_MS = 50;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The runtime twin ships next to this module: the .js build in the
// published package, the .ts source when tests run from source (node
// strips the types in the spawned mock process).
const ownPath = fileURLToPath(import.meta.url);
const runtimeUrl = pathToFileURL(path.join(path.dirname(ownPath), `mock-bin-behaviour-runtime${path.extname(ownPath)}`)).href;
const toLines = (value) => {
    if (value === undefined)
        return [];
    return typeof value === "string" ? [value] : [...value];
};
const toLifetimeMs = (option) => {
    if (option === undefined || option === false)
        return undefined;
    if (option === true)
        return LIFETIME_MS;
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
const bootstrapCode = (script) => `import(${JSON.stringify(runtimeUrl)}).then((runtime) =>\n` +
    `  runtime.runMockBehaviour(${JSON.stringify(script)}),\n);\n`;
/**
 * Compiles a behaviour into the mock's script, creating the directory
 * its invocations are recorded into when recording is on.
 */
const prepareBehaviour = async (binName, pattern, behaviour) => {
    const record = behaviour.record ?? true;
    const recordDir = record === false
        ? undefined
        : await mkdtemp(path.join(tmpdir(), "type-a-bin-calls-"));
    const spawnChildMs = toLifetimeMs(behaviour.spawnChild);
    const trapSignalsMs = toLifetimeMs(behaviour.trapSignals);
    const script = {
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
 * Parses one record, reading a slot the runtime has claimed but not
 * yet published (an empty file, which `JSON.parse` rejects like a
 * truncated one) as absent. Publishing is by atomic rename, so
 * truncation should not occur — tolerating it anyway keeps a polling
 * reader from crashing mid-wait.
 */
const parseRecord = (file) => {
    try {
        return JSON.parse(readFileSync(file, "utf-8"));
    }
    catch {
        return undefined;
    }
};
/**
 * Reads the recorded invocations in the order the mock was called: the
 * runtime numbers each record as it claims a slot. The `.json` suffix
 * filters out records still being written to their `.pending` sidecar,
 * and a slot not fully published yet is skipped until its record lands.
 */
const readCalls = (recordDir) => readdirSync(recordDir)
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10))
    .flatMap((name) => {
    const record = parseRecord(path.join(recordDir, name));
    return record === undefined ? [] : [record];
});
/**
 * Turns a cleanup function into the handle a scripted behaviour
 * returns. Cleanup snapshots the recorded calls before removing the
 * record directory, so assertions still read after teardown.
 */
const withCalls = (cleanup, recordDir) => {
    let snapshot;
    const handle = () => {
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
    // The read both `calls` and `waitForCall` share: the frozen
    // snapshot after cleanup, a fresh reading of the records before it.
    const currentCalls = () => snapshot ?? (recordDir === undefined ? [] : readCalls(recordDir));
    const describeRecorded = () => {
        const calls = currentCalls();
        return calls.length === 0
            ? "none"
            : calls.map((call) => JSON.stringify(call.args)).join(", ");
    };
    const waitForCall = async (predicate, timeoutMs) => {
        if (recordDir === undefined)
            throw new Error("waitForCall: the behaviour records nothing, so no invocation " +
                "can ever match");
        const matches = predicate ?? (() => true);
        const budgetMs = timeoutMs ?? WAIT_TIMEOUT_MS;
        const deadline = Date.now() + budgetMs;
        for (;;) {
            const match = currentCalls().find(matches);
            if (match !== undefined)
                return match;
            // Cleanup froze the records at their snapshot, so a miss can
            // never turn into a hit — fail now instead of burning the budget.
            if (snapshot !== undefined)
                throw new Error("waitForCall: no invocation matched, and the mock is already " +
                    `cleaned up — calls recorded: ${describeRecorded()}`);
            if (Date.now() >= deadline)
                throw new Error("waitForCall: no invocation matched within " +
                    `${budgetMs}ms — calls recorded so far: ${describeRecorded()}`);
            await sleep(WAIT_POLL_MS);
        }
    };
    Object.defineProperties(handle, {
        calls: { enumerable: true, get: currentCalls },
        waitForCall: { enumerable: true, value: waitForCall },
    });
    return handle;
};
export { prepareBehaviour, withCalls, };
