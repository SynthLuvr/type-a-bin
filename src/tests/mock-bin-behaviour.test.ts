import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mockBin } from "../mock-bin.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the predicate holds, so timing tests need no fixed wait. */
const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(10);
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const exited = (child: ReturnType<typeof spawn>): Promise<void> =>
  new Promise((resolve) => child.once("exit", () => resolve()));

describe("mockBin scripted behaviour", () => {
  it("records the arguments, cwd and environment of every call", async () => {
    const mock = await mockBin("gh", { stdout: "ok" });

    spawnSync("gh", ["pr", "list"], {
      encoding: "utf-8",
      cwd: process.cwd(),
      env: { ...process.env, GH_TOKEN: "secret" },
    });
    spawnSync("gh", ["pr", "view", "7"], { encoding: "utf-8" });

    expect(mock.calls.map((call) => call.args)).toEqual([
      ["pr", "list"],
      ["pr", "view", "7"],
    ]);
    expect(mock.calls[0]?.cwd).toBe(process.cwd());
    expect(mock.calls[0]?.env.GH_TOKEN).toBe("secret");
    expect(mock.calls[0]?.pid).toBeGreaterThan(0);
    expect(mock.calls[0]?.stdin).toBe(undefined);

    mock();
  });

  it("writes the scripted stdout, stderr and exit code", async () => {
    const mock = await mockBin("gh", {
      stdout: ["#1 first", "#2 second"],
      stderr: "rate limit warning",
      exitCode: 3,
    });

    const result = spawnSync("gh", ["pr", "list"], { encoding: "utf-8" });

    expect(result.stdout).toBe("#1 first\n#2 second\n");
    expect(result.stderr).toBe("rate limit warning\n");
    expect(result.status).toBe(3);

    mock();
  });

  it("mocks an invocation with no arguments", async () => {
    const mock = await mockBin("gh", { stdout: "no args", exitCode: 2 });

    const result = spawnSync("gh", { encoding: "utf-8" });

    expect(result.stdout).toBe("no args\n");
    expect(result.status).toBe(2);
    expect(mock.calls[0]?.args).toEqual([]);

    mock();
  });

  it("defaults to a silent, successful, recorded mock", async () => {
    const mock = await mockBin("gh", {});

    const result = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });

    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
    expect(mock.calls).toHaveLength(1);

    mock();
  });

  it("records stdin when the behaviour asks for it", async () => {
    const mock = await mockBin("gh", {
      record: { stdin: true },
      stdout: "created",
    });

    const result = spawnSync("gh", ["pr", "create"], {
      encoding: "utf-8",
      input: "the prompt body",
    });

    expect(result.stdout).toBe("created\n");
    expect(mock.calls[0]?.stdin).toBe("the prompt body");

    mock();
  });

  it("records nothing when recording is turned off", async () => {
    const mock = await mockBin("gh", { record: false, stdout: "ok" });

    const result = spawnSync("gh", ["pr", "list"], { encoding: "utf-8" });

    expect(result.stdout).toBe("ok\n");
    expect(mock.calls).toEqual([]);

    mock();
  });

  it("spaces stdout lines by lineDelayMs", async () => {
    const mock = await mockBin("gh", {
      stdout: ["one", "two", "three"],
      lineDelayMs: 120,
    });

    const started = Date.now();
    const result = spawnSync("gh", ["pr", "list"], { encoding: "utf-8" });

    expect(result.stdout).toBe("one\ntwo\nthree\n");
    // Two gaps between three lines, with slack for early timers.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);

    mock();
  });

  it("records a delayed call before the mock has answered", async () => {
    const mock = await mockBin("gh", { delayMs: 1000, stdout: "late" });

    const child = spawn("gh", ["pr", "list"], { stdio: "ignore" });
    await waitFor(() => mock.calls.length === 1);

    expect(child.exitCode).toBe(null);
    expect(mock.calls[0]?.args).toEqual(["pr", "list"]);

    await exited(child);
    mock();
  });

  it("mocks only the commands a pattern matches", async () => {
    const mock = await mockBin(
      { binName: "git", pattern: "^git status" },
      { stdout: "mocked status" },
    );

    const status = spawnSync("git", ["status"], { encoding: "utf-8" });
    expect(status.stdout).toBe("mocked status\n");

    const version = spawnSync("git", ["version"], { encoding: "utf-8" });
    expect(version.status).toBe(0);
    expect(version.stdout).toContain("git version");

    // A pattern miss runs the real binary, so it is not an invocation
    // this mock handled.
    expect(mock.calls.map((call) => call.args)).toEqual([["status"]]);

    mock();
  });

  it("reports a pattern miss with no real binary as not found", async () => {
    const mock = await mockBin(
      { binName: "nonexistent-fake-binary-xyz", pattern: "^\\S+ mocked" },
      { stdout: "mocked" },
    );

    const result = spawnSync("nonexistent-fake-binary-xyz", ["real"], {
      encoding: "utf-8",
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain(
      "Real binary 'nonexistent-fake-binary-xyz' not found",
    );

    mock();
  });

  it("spawns a descendant that outlives the mock", async () => {
    const mock = await mockBin("gh", { spawnChild: { lifetimeMs: 30_000 } });

    spawnSync("gh", ["run", "watch"], { encoding: "utf-8" });

    const childPid = mock.calls[0]?.childPid ?? 0;
    expect(childPid).toBeGreaterThan(0);
    expect(isAlive(childPid)).toBe(true);

    process.kill(childPid, "SIGKILL");
    await waitFor(() => !isAlive(childPid));

    mock();
  });

  it.runIf(process.platform !== "win32")(
    "survives SIGTERM when the behaviour traps signals",
    async () => {
      const mock = await mockBin("gh", {
        trapSignals: true,
        stdout: "watching",
      });

      const child = spawn("gh", ["run", "watch"], { stdio: "ignore" });
      await waitFor(() => mock.calls.length === 1);

      child.kill("SIGTERM");
      await sleep(300);
      expect(child.exitCode).toBe(null);

      child.kill("SIGKILL");
      await exited(child);

      mock();
    },
  );

  it("cleans up like any other mock and keeps serving its calls", async () => {
    const originalPath = process.env.PATH;
    const mock = await mockBin("gh", { stdout: "ok" });

    expect(process.env.PATH).not.toBe(originalPath);
    spawnSync("gh", ["pr", "list"], { encoding: "utf-8" });

    mock();

    expect(process.env.PATH).toBe(originalPath);
    expect(mock.calls.map((call) => call.args)).toEqual([["pr", "list"]]);

    // Cleaning up twice must stay safe, records and all.
    mock();
    expect(mock.calls).toHaveLength(1);
  });
});
