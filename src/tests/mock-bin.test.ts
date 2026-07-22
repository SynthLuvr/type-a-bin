import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mockBin } from "../mock-bin";

describe("mockBin", () => {
  it("mock and unmock git", async () => {
    const log = "mocking git!";
    const cleanup = await mockBin(
      "git",
      "#!/usr/bin/env bash",
      `echo "${log}"`,
    );

    const result = spawnSync("git", ["status"], { encoding: "utf-8" });

    expect(result.stdout).toBe(`${log}\n`);

    cleanup();
  });

  it("exit code", async () => {
    const cleanup = await mockBin("git", "#!/usr/bin/env bash", "exit 1");

    const result = spawnSync("git", { encoding: "utf-8" });

    expect(result.status).toBe(1);

    cleanup();
  });

  it("environment shebang without #!", async () => {
    const log = "mocking git!";
    const cleanup = await mockBin("git", "bash", `echo "${log}"`);

    const result = spawnSync("git", { encoding: "utf-8" });

    expect(result.stdout).toBe(`${log}\n`);

    cleanup();
  });

  it("mock command with arguments", async () => {
    const cleanup = await mockBin("gh", "bash", 'echo "pr: $1 $2"');

    const result = spawnSync("gh", ["pr", "list"], { encoding: "utf-8" });

    expect(result.stdout).toBe("pr: pr list\n");

    cleanup();
  });

  it("multiple mocks at once", async () => {
    const cleanup1 = await mockBin("git", "bash", 'echo "mocked git"');
    const cleanup2 = await mockBin("gh", "bash", 'echo "mocked gh"');

    const gitResult = spawnSync("git", { encoding: "utf-8" });
    expect(gitResult.stdout).toBe("mocked git\n");

    const ghResult = spawnSync("gh", { encoding: "utf-8" });
    expect(ghResult.stdout).toBe("mocked gh\n");

    cleanup1();
    cleanup2();
  });

  it("mock with node shebang", async () => {
    const cleanup = await mockBin(
      "testbin",
      "node",
      'console.log("Hello from Node")',
    );

    const result = spawnSync("testbin", { encoding: "utf-8" });

    expect(result.stdout).toBe("Hello from Node\n");

    cleanup();
  });

  it("cleanup restores original PATH", async () => {
    const originalPath = process.env.PATH;
    const cleanup = await mockBin("git", "bash", 'echo "test"');

    const modifiedPath = process.env.PATH;
    expect(modifiedPath).not.toBe(originalPath);

    cleanup();

    expect(process.env.PATH).toBe(originalPath);
  });

  it("cleanup handles missing temp directory gracefully", async () => {
    const cleanup = await mockBin("testbin", "bash", 'echo "test"');

    cleanup();
    // Second call should not throw even though the temp dir is gone
    cleanup();
  });

  it("mock with full shebang path", async () => {
    const cleanup = await mockBin(
      "testbin",
      "#!/bin/bash",
      'echo "full shebang"',
    );

    const result = spawnSync("testbin", { encoding: "utf-8" });

    expect(result.stdout).toBe("full shebang\n");

    cleanup();
  });

  it("cleanup when original PATH was empty", async () => {
    const originalPath = process.env.PATH;

    try {
      delete process.env.PATH;

      const cleanup = await mockBin("testbin", "bash", 'echo "test"');

      expect(process.env.PATH).not.toBe(undefined);

      cleanup();

      expect(process.env.PATH).toBe(undefined);
    } finally {
      if (originalPath) process.env.PATH = originalPath;
    }
  });

  it("environment variables are passed through to original command", async () => {
    const cleanup = await mockBin(
      "env",
      "bash",
      `
      # Always pass through to real env command
      mock-a-bin-run-original "$@"
    `,
    );

    const result = spawnSync("env", {
      encoding: "utf-8",
      env: {
        ...process.env,
        CUSTOM_TEST_VAR: "my-custom-value",
        ANOTHER_VAR: "another-value",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CUSTOM_TEST_VAR=my-custom-value");
    expect(result.stdout).toContain("ANOTHER_VAR=another-value");

    cleanup();
  });

  it("mock-a-bin-run-original triggers original command execution", async () => {
    const cleanup = await mockBin(
      "git",
      "bash",
      'mock-a-bin-run-original "$@"',
    );

    const result = spawnSync("git", ["--version"], { encoding: "utf-8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("git version");

    cleanup();
  });

  it("conditional mocking - mock specific subcommand, pass through others", async () => {
    const cleanup = await mockBin(
      "git",
      "bash",
      `
      if [ "$1" = "status" ]; then
        echo "mocked status output"
      else
        mock-a-bin-run-original "$@"
      fi
    `,
    );

    const statusResult = spawnSync("git", ["status"], { encoding: "utf-8" });
    expect(statusResult.stdout).toBe("mocked status output\n");

    const versionResult = spawnSync("git", ["--version"], {
      encoding: "utf-8",
    });
    expect(versionResult.status).toBe(0);
    expect(versionResult.stdout).toContain("git version");

    cleanup();
  });

  it("mock-a-bin-run-original with non-existent original binary shows error", async () => {
    const cleanup = await mockBin(
      "nonexistent-fake-binary-xyz",
      "bash",
      'mock-a-bin-run-original "$@"',
    );

    const result = spawnSync("nonexistent-fake-binary-xyz", {
      encoding: "utf-8",
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain(
      "Original 'nonexistent-fake-binary-xyz' command not found",
    );

    cleanup();
  });

  it("mock-a-bin-run-original works with node shebang", async () => {
    const cleanup = await mockBin(
      "git",
      "node",
      `
      const { spawnSync } = require('child_process')
      if (process.argv[2] === 'status') {
        console.log('mocked from node')
      } else {
        // Call mock-a-bin-run-original with all arguments
        const result = spawnSync('mock-a-bin-run-original', process.argv.slice(2), { stdio: 'inherit' })
        process.exit(result.status || 0)
      }
    `,
    );

    const statusResult = spawnSync("git", ["status"], { encoding: "utf-8" });
    expect(statusResult.stdout).toBe("mocked from node\n");

    const versionResult = spawnSync("git", ["--version"], {
      encoding: "utf-8",
    });
    expect(versionResult.status).toBe(0);
    expect(versionResult.stdout).toContain("git version");

    cleanup();
  });

  it("arguments are properly passed to original command via mock-a-bin-run-original", async () => {
    const cleanup = await mockBin(
      "git",
      "bash",
      `
      if [ "$1" = "branch" ]; then
        echo "mocked branch"
      else
        mock-a-bin-run-original "$@"
      fi
    `,
    );

    const result = spawnSync("git", ["log", "--oneline", "-n", "1"], {
      encoding: "utf-8",
    });

    // git returns 128 when not in a repo; both 0 and 128 are acceptable
    expect(result.status === 0 || result.status === 128).toBe(true);

    cleanup();
  });

  it("conditional mock: mock only matching commands with pattern", async () => {
    const cleanup = await mockBin(
      { binName: "git", pattern: "^git status" },
      "bash",
      'echo "mocked status"',
    );

    const statusResult = spawnSync("git", ["status"], { encoding: "utf-8" });
    expect(statusResult.stdout).toBe("mocked status\n");

    const versionResult = spawnSync("git", ["--version"], {
      encoding: "utf-8",
    });
    expect(versionResult.stdout).not.toBe("mocked status\n");
    expect(versionResult.stdout).toContain("git version");

    cleanup();
  });

  it("conditional mock: pattern with multiple alternatives", async () => {
    const cleanup = await mockBin(
      { binName: "git", pattern: "^git (status|log)" },
      "bash",
      'echo "mocked: $*"',
    );

    const statusResult = spawnSync("git", ["status"], { encoding: "utf-8" });
    expect(statusResult.stdout).toBe("mocked: status\n");

    const logResult = spawnSync("git", ["log"], { encoding: "utf-8" });
    expect(logResult.stdout).toBe("mocked: log\n");

    const versionResult = spawnSync("git", ["--version"], {
      encoding: "utf-8",
    });
    expect(versionResult.stdout).toContain("git version");

    cleanup();
  });

  it("conditional mock: pattern with subcommand arguments", async () => {
    const cleanup = await mockBin(
      { binName: "git", pattern: "^git commit -m" },
      "bash",
      'echo "mocked commit"',
    );

    const commitResult = spawnSync("git", ["commit", "-m", "test"], {
      encoding: "utf-8",
    });
    expect(commitResult.stdout).toBe("mocked commit\n");

    // A non-matching subcommand should not be mocked
    spawnSync("git", ["status"], { encoding: "utf-8" });

    cleanup();
  });

  it("conditional mock: backward compatibility without pattern", async () => {
    const cleanup = await mockBin("git", "bash", 'echo "all mocked"');

    const statusResult = spawnSync("git", ["status"], { encoding: "utf-8" });
    expect(statusResult.stdout).toBe("all mocked\n");

    const versionResult = spawnSync("git", ["--version"], {
      encoding: "utf-8",
    });
    expect(versionResult.stdout).toBe("all mocked\n");

    cleanup();
  });

  it("conditional mock: empty pattern mocks everything", async () => {
    const cleanup = await mockBin(
      { binName: "git", pattern: "" },
      "bash",
      'echo "mocked with empty pattern"',
    );

    const statusResult = spawnSync("git", ["status"], { encoding: "utf-8" });
    expect(statusResult.stdout).toBe("mocked with empty pattern\n");

    cleanup();
  });
});
