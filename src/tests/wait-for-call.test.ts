import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mockBin } from "../mock-bin.js";
import { type MockBinCall, withCalls } from "../mock-bin-behaviour.js";

// A scripted mock answers in another process, so the record of an
// invocation lands on disk some time after the spawn that caused it.
// waitForCall exists for exactly that gap: these tests drive it with
// real spawned processes whose invocations arrive late, on purpose.

const exited = (child: ReturnType<typeof spawn>): Promise<void> =>
  new Promise((resolve) => child.once("exit", () => resolve()));

/** Spawns node, which invokes the mocked gh only after `delayMs`. */
const invokeGhAfter = (
  delayMs: number,
  args: string[],
): ReturnType<typeof spawn> =>
  spawn(process.execPath, [
    "-e",
    `const { spawnSync } = require("node:child_process");
setTimeout(() => {
  spawnSync("gh", ${JSON.stringify(args)}, { encoding: "utf-8" });
}, ${delayMs});`,
  ]);

const fakeRecord = (args: string[]): MockBinCall => ({
  args,
  cwd: "/tmp",
  env: {},
  pid: 1,
});

describe("waitForCall", () => {
  it("resolves with the invocation once it is recorded", async () => {
    const mock = await mockBin("gh", { stdout: "ok" });
    const started = Date.now();
    const child = invokeGhAfter(400, ["pr", "list"]);
    // Registered up front: waitForCall can resolve after the child has
    // already exited, and an "exit" listener attached that late never
    // fires.
    const childDone = exited(child);

    const call = await mock.waitForCall(
      (candidate) => candidate.args[0] === "pr",
      8_000,
    );

    expect(call.args).toEqual(["pr", "list"]);
    // The invocation happens at 400ms, so a match this late proves the
    // helper polled rather than read `calls` once.
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    await childDone;
    mock();
  });

  it("resolves immediately for an invocation already recorded", async () => {
    const mock = await mockBin("gh", { stdout: "ok" });
    spawnSync("gh", ["pr", "view", "7"], { encoding: "utf-8" });

    const call = await mock.waitForCall(
      (candidate) => candidate.args[0] === "pr",
    );

    expect(call.args).toEqual(["pr", "view", "7"]);
    mock();
  });

  it("waits for any invocation when no predicate is given", async () => {
    const mock = await mockBin("gh", { stdout: "ok" });
    const child = invokeGhAfter(300, ["auth", "status"]);
    const childDone = exited(child);

    const call = await mock.waitForCall(undefined, 8_000);

    expect(call.args).toEqual(["auth", "status"]);
    await childDone;
    mock();
  });

  it("skips recorded invocations the predicate rejects", async () => {
    const mock = await mockBin("gh", { stdout: "ok" });
    spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
    spawnSync("gh", ["pr", "list"], { encoding: "utf-8" });

    const call = await mock.waitForCall((candidate) =>
      candidate.args.includes("list"),
    );

    expect(call.args).toEqual(["pr", "list"]);
    mock();
  });

  it("rejects on timeout, listing the invocations recorded", async () => {
    const mock = await mockBin("gh", { stdout: "ok" });
    spawnSync("gh", ["pr", "list"], { encoding: "utf-8" });

    let failure: unknown;
    try {
      await mock.waitForCall(
        (candidate) => candidate.args.includes("nope"),
        150,
      );
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("within 150ms");
    expect(String(failure)).toContain('["pr","list"]');
    mock();
  });

  it("rejects with a message that names the empty record set", async () => {
    const mock = await mockBin("gh", { stdout: "ok" });

    await expect(mock.waitForCall(undefined, 100)).rejects.toThrow(
      "calls recorded so far: none",
    );

    mock();
  });

  it("rejects at once when the behaviour records nothing", async () => {
    const mock = await mockBin("gh", { record: false, stdout: "ok" });
    spawnSync("gh", ["pr", "list"], { encoding: "utf-8" });
    const started = Date.now();

    await expect(mock.waitForCall(undefined, 10_000)).rejects.toThrow(
      "records nothing",
    );
    expect(Date.now() - started).toBeLessThan(5_000); // immediate

    mock();
  });

  it("serves the snapshot after cleanup, failing fast on a miss", async () => {
    const mock = await mockBin("gh", { stdout: "ok" });
    spawnSync("gh", ["pr", "list"], { encoding: "utf-8" });
    mock();

    const call = await mock.waitForCall(
      (candidate) => candidate.args.includes("pr"),
      100,
    );
    expect(call.args).toEqual(["pr", "list"]);

    const started = Date.now();
    await expect(
      mock.waitForCall((candidate) => candidate.args.includes("nope"), 10_000),
    ).rejects.toThrow("already cleaned up");
    // Teardown froze the records, so the miss rejects at once.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("skips a slot a concurrent writer claimed but has not filled", async () => {
    const recordDir = await mkdtemp(path.join(tmpdir(), "type-a-bin-wfc-"));
    // Slot 0 claimed but still being described (empty file), slot 1
    // already published — the order two concurrent invocations leave.
    await writeFile(path.join(recordDir, "0.json"), "");
    const second = fakeRecord(["pr", "list"]);
    await writeFile(path.join(recordDir, "1.json"), JSON.stringify(second));
    const handle = withCalls(() => undefined, recordDir);

    const call = await handle.waitForCall(
      (candidate) => candidate.args.includes("pr"),
      1_000,
    );

    expect(call).toEqual(second);
    handle();
  });

  it("skips a record caught mid-write rather than crashing the wait", async () => {
    const recordDir = await mkdtemp(path.join(tmpdir(), "type-a-bin-wfc-"));
    // A truncated slot-0 record: the wait must read past it, not die on it.
    await writeFile(path.join(recordDir, "0.json"), '{"args":["pr",');
    const second = fakeRecord(["auth", "status"]);
    await writeFile(path.join(recordDir, "1.json"), JSON.stringify(second));
    const handle = withCalls(() => undefined, recordDir);

    const call = await handle.waitForCall(undefined, 1_000);

    expect(call).toEqual(second);
    handle();
  });
});
