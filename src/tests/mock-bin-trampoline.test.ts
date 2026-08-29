import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockBin } from "../mock-bin.js";

// Windows acceptance suite for the argv-preserving trampoline launcher:
// every test runs the real mockBin against the real child_process, with
// the mock resolving through PATH to the copied launcher. The
// flag-first, multiline, and kill scenarios below are the ones the
// legacy node.exe-hardlink mechanism could not support (issue #26).
const runIfWindows = it.runIf(process.platform === "win32");

let captureDir: string;

const capturePath = (name: string): string =>
  path.join(captureDir, `${name}.json`);

/** Node mock code that records what the mock itself observed. */
const captureArgsCode = (capture: string): string =>
  `const { writeFileSync } = require("node:fs");\n` +
  `writeFileSync(${JSON.stringify(capture)}, ` +
  `JSON.stringify(process.argv.slice(2)));\n`;

beforeAll(async () => {
  captureDir = await mkdtemp(path.join(tmpdir(), "type-a-bin-trampoline-"));
});

afterAll(async () => {
  await rm(captureDir, { recursive: true, force: true });
});

/** Polls until the check passes, bounded by a timeout. */
const waitUntil = async (
  check: () => boolean,
  timeoutMs = 15_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
};

const isGone = (pid: number | undefined): boolean => {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe("windows trampoline launcher", () => {
  runIfWindows(
    "preserves flag-first argv and multiline arguments",
    async () => {
      const capture = capturePath("argv");
      const cleanup = await mockBin("claude", "node", captureArgsCode(capture));
      const args = [
        "--session-id",
        "00000000-0000-0000-0000-000000000000",
        "--append-system-prompt",
        'line one\nline "two"',
        "--print",
      ];

      const result = spawnSync("claude", args, { encoding: "utf-8" });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(readFileSync(capture, "utf-8"))).toEqual(args);

      cleanup();
    },
  );

  runIfWindows(
    "round-trips quotes, trailing backslashes, and non-ASCII text",
    async () => {
      const capture = capturePath("tricky");
      const cleanup = await mockBin("claude", "node", captureArgsCode(capture));
      const args = [
        'embedded "quotes" and \\ backslashes',
        "trailing\\",
        "ünicode-Ω-日本語",
        "",
        "  leading and trailing spaces  ",
        "tab\tseparated",
      ];

      const result = spawnSync("claude", args, { encoding: "utf-8" });

      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(capture, "utf-8"))).toEqual(args);

      cleanup();
    },
  );

  runIfWindows(
    "runs a flag-first mock with no positional argument",
    async () => {
      const cleanup = await mockBin("gh", "mocked gh output");

      const result = spawnSync("gh", ["--version"], { encoding: "utf-8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("mocked gh output\n");

      cleanup();
    },
  );

  runIfWindows("runs the mock with no arguments at all", async () => {
    const capture = capturePath("no-args");
    const cleanup = await mockBin("claude", "node", captureArgsCode(capture));

    const result = spawnSync("claude", [], { encoding: "utf-8" });

    // The launcher always hands Node a real script, so an argumentless
    // invocation runs the mock and never falls into the REPL.
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(readFileSync(capture, "utf-8"))).toEqual([]);

    cleanup();
  });

  runIfWindows(
    "matches POSIX stdio, environment, cwd, and exit-code behaviour",
    async () => {
      const cleanup = await mockBin(
        "claude",
        "node",
        `
        const chunks = [];
        process.stdin.on("data", (chunk) => chunks.push(chunk));
        process.stdin.on("end", () => {
          process.stdout.write(process.cwd() + "\\n");
          process.stdout.write(process.env.TRAMPOLINE_TEST_VAR + "\\n");
          process.stdout.write(Buffer.concat(chunks).toString("utf-8"));
          process.exit(7);
        });
      `,
      );
      const workDir = await mkdtemp(path.join(tmpdir(), "trampoline-cwd-"));
      try {
        const result = spawnSync("claude", [], {
          encoding: "utf-8",
          cwd: workDir,
          input: "stdin payload\n",
          env: { ...process.env, TRAMPOLINE_TEST_VAR: "env-value" },
        });

        expect(result.status).toBe(7);
        expect(result.stdout).toBe(`${workDir}\nenv-value\nstdin payload\n`);
      } finally {
        cleanup();
        await rm(workDir, { recursive: true, force: true });
      }
    },
  );

  runIfWindows(
    "forwards pattern misses to the real binary with flag-first argv",
    async () => {
      const cleanup = await mockBin(
        { binName: "git", pattern: "^git push" },
        "bash",
        'echo "pushed"',
      );

      const result = spawnSync("git", ["--version"], { encoding: "utf-8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("git version");

      cleanup();
    },
  );

  runIfWindows(
    "forwards flag-first argv from mock-a-bin-run-original",
    async () => {
      const cleanup = await mockBin(
        "git",
        "node",
        `
        const { spawnSync } = require("node:child_process");
        const result = spawnSync("mock-a-bin-run-original", ["--version"], {
          stdio: "inherit",
        });
        process.exit(result.status ?? 1);
      `,
      );

      const result = spawnSync("git", ["anything"], { encoding: "utf-8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("git version");

      cleanup();
    },
  );

  runIfWindows(
    "runs TypeScript script files with flag-first argv",
    async () => {
      const capture = capturePath("ts");
      const script = path.join(captureDir, "mock.ts");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        script,
        `import { writeFileSync } from "node:fs";
         const args: string[] = process.argv.slice(2);
         writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args));
        `,
      );

      const cleanup = await mockBin("claude", { file: script });
      const args = ["--flag", "value"];

      const result = spawnSync("claude", args, { encoding: "utf-8" });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(readFileSync(capture, "utf-8"))).toEqual(args);

      cleanup();
    },
  );

  runIfWindows(
    "killing the spawned mock reaps the launcher, the mock, and descendants",
    async () => {
      const mock = await mockBin("claude", {
        stdout: ["ready"],
        // The trapped-signal timer keeps the mock alive until the kill
        // lands; the spawned descendant proves the whole tree goes down.
        spawnChild: { lifetimeMs: 60_000 },
        trapSignals: { lifetimeMs: 60_000 },
      });
      const child = spawn("claude", ["--flag", "first"], {
        stdio: "ignore",
      });

      try {
        const recorded = await waitUntil(() => mock.calls.length > 0);
        expect(recorded).toBe(true);
        const call = mock.calls[0];
        if (call === undefined) throw new Error("no recorded call");
        expect(call.args).toEqual(["--flag", "first"]);

        child.kill();

        const reaped = await waitUntil(
          () => isGone(call.pid) && isGone(call.childPid),
        );
        expect(reaped).toBe(true);
      } finally {
        mock();
      }
    },
    45_000,
  );

  runIfWindows(
    "cleanup removes the launcher and bootstrap after a killed mock",
    async () => {
      const mock = await mockBin("claude", {
        stdout: ["ready"],
        trapSignals: { lifetimeMs: 60_000 },
      });
      const child = spawn("claude", [], { stdio: "ignore" });

      const recorded = await waitUntil(() => mock.calls.length > 0);
      expect(recorded).toBe(true);
      const record = mock.calls[0];
      if (record === undefined) throw new Error("no recorded call");
      // Windows records the variable as "Path"; look it up without case.
      const pathValue = Object.entries(record.env).find(
        ([key]) => key.toUpperCase() === "PATH",
      )?.[1];
      const mockDir = pathValue?.split(path.delimiter)[0];
      expect(mockDir).toBeDefined();

      child.kill();
      await waitUntil(() => isGone(record.pid));
      mock();

      // rmScratch retries on Windows, so removal settles after cleanup.
      const removed = await waitUntil(() => !existsSync(mockDir as string));
      expect(removed).toBe(true);
    },
    45_000,
  );
});
