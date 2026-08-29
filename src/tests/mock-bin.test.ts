import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mockBin } from "../mock-bin.js";
import { MOCKS_VAR } from "../mock-bin-env.js";

/** Creates a temp script file, mocks `testbin` to run it, returns stdout. */
const runScriptFile = async (options: {
  content: string;
  extension: string;
  /** Omit to let the shorthand pick the interpreter from the extension. */
  shebang?: string;
  args?: string[];
  /** Working directory the mocked binary runs in. */
  cwd?: string;
}): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "mockbin-"));
  const scriptPath = path.join(dir, `mock.${options.extension}`);
  await writeFile(scriptPath, options.content);

  const cleanup =
    options.shebang === undefined
      ? await mockBin("testbin", { file: scriptPath })
      : await mockBin("testbin", options.shebang, { file: scriptPath });
  const result = spawnSync("testbin", options.args ?? [], {
    encoding: "utf-8",
    cwd: options.cwd,
  });
  cleanup();
  await rm(dir, { recursive: true, force: true });
  return result.stdout;
};

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

  it("mock by output string (output shorthand)", async () => {
    const log = "mocking git!";
    const cleanup = await mockBin("git", log);

    const result = spawnSync("git", ["status"], { encoding: "utf-8" });

    expect(result.stdout).toBe(`${log}\n`);

    cleanup();
  });

  it("output shorthand with config and pattern", async () => {
    const cleanup = await mockBin(
      { binName: "git", pattern: "^git status" },
      "mocked status",
    );

    const statusResult = spawnSync("git", ["status"], { encoding: "utf-8" });
    expect(statusResult.stdout).toBe("mocked status\n");

    const versionResult = spawnSync("git", ["version"], {
      encoding: "utf-8",
    });
    expect(versionResult.stdout).toContain("git version");

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

  it("mock with node interpreter receives arguments", async () => {
    const cleanup = await mockBin(
      "testbin",
      "node",
      'console.log("args: " + process.argv.slice(2).join(" "))',
    );

    const result = spawnSync("testbin", ["one", "two"], {
      encoding: "utf-8",
    });

    expect(result.stdout).toBe("args: one two\n");

    cleanup();
  });

  it("output shorthand expands positional parameters", async () => {
    const cleanup = await mockBin("testbin", "value: $1 and $2");

    const result = spawnSync("testbin", ["a", "b"], { encoding: "utf-8" });

    expect(result.stdout).toBe("value: a and b\n");

    cleanup();
  });

  it.runIf(process.platform === "win32")(
    "windows: cleanup restores NODE_OPTIONS and the mock registry",
    async () => {
      const previousNodeOptions = process.env.NODE_OPTIONS;
      const previousMocks = process.env[MOCKS_VAR];
      const cleanup = await mockBin("testbin", "bash", 'echo "test"');

      expect(process.env.NODE_OPTIONS).not.toBe(previousNodeOptions);
      expect(process.env[MOCKS_VAR]).not.toBe(previousMocks);

      cleanup();

      expect(process.env.NODE_OPTIONS).toBe(previousNodeOptions);
      expect(process.env[MOCKS_VAR]).toBe(previousMocks);
    },
  );

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
    // `env` does not exist on Windows. git reads configuration from the
    // environment (GIT_CONFIG_*), so the same passthrough is proven there
    // by asking the real git (via mock-a-bin-run-original) to print an
    // environment-provided config value.
    const isWindows = process.platform === "win32";
    const binName = isWindows ? "git" : "env";
    const args = isWindows ? ["config", "test.customVar"] : [];
    const passthroughEnv = isWindows
      ? {
          ...process.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "test.customVar",
          GIT_CONFIG_VALUE_0: "my-custom-value",
        }
      : {
          ...process.env,
          CUSTOM_TEST_VAR: "my-custom-value",
          ANOTHER_VAR: "another-value",
        };

    const cleanup = await mockBin(
      binName,
      "bash",
      `
      # Always pass through to real command
      mock-a-bin-run-original "$@"
    `,
    );

    const result = spawnSync(binName, args, {
      encoding: "utf-8",
      env: passthroughEnv,
    });

    expect(result.status).toBe(0);
    if (isWindows) expect(result.stdout).toContain("my-custom-value");
    else {
      expect(result.stdout).toContain("CUSTOM_TEST_VAR=my-custom-value");
      expect(result.stdout).toContain("ANOTHER_VAR=another-value");
    }

    cleanup();
  });

  it("mock-a-bin-run-original triggers original command execution", async () => {
    const cleanup = await mockBin(
      "git",
      "bash",
      'mock-a-bin-run-original "$@"',
    );

    const result = spawnSync("git", ["version"], { encoding: "utf-8" });

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

    const versionResult = spawnSync("git", ["version"], {
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

    const versionResult = spawnSync("git", ["version"], {
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

    const versionResult = spawnSync("git", ["version"], {
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

    const versionResult = spawnSync("git", ["version"], {
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

    const versionResult = spawnSync("git", ["version"], {
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

  it("mock with a script file (node)", async () => {
    expect(
      await runScriptFile({
        content: 'console.log("hello from file")',
        extension: "js",
        shebang: "node",
      }),
    ).toBe("hello from file\n");
  });

  it("mock with a TypeScript script file via node --import tsx", async () => {
    expect(
      await runScriptFile({
        content: 'const value: number = 42; console.log("ts value " + value);',
        extension: "ts",
        shebang: "node --import tsx",
      }),
    ).toBe("ts value 42\n");
  });

  it("mock with a bash script file", async () => {
    expect(
      await runScriptFile({
        content: 'echo "from bash file $1"',
        extension: "sh",
        shebang: "bash",
        args: ["arg"],
      }),
    ).toBe("from bash file arg\n");
  });

  it("script file with pattern mocks matching commands only", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mockbin-pattern-"));
    const scriptPath = path.join(dir, "mock.js");
    await writeFile(scriptPath, 'console.log("file mock")');

    const cleanup = await mockBin(
      { binName: "git", pattern: "^git status" },
      "node",
      { file: scriptPath },
    );

    const statusResult = spawnSync("git", ["status"], { encoding: "utf-8" });
    expect(statusResult.stdout).toBe("file mock\n");

    const versionResult = spawnSync("git", ["version"], {
      encoding: "utf-8",
    });
    expect(versionResult.stdout).toContain("git version");

    cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("throws when the script file does not exist", async () => {
    await expect(
      mockBin("testbin", "node", { file: "/nonexistent/mock-script.js" }),
    ).rejects.toThrow("script file not found");
  });

  describe("script-file shorthand", () => {
    it("runs TypeScript through the tsx loader from any cwd", async () => {
      // The enum needs a real transform (native type stripping rejects
      // it) and the cwd sits outside this package, where a bare
      // `--import tsx` cannot resolve — so passing proves the shorthand
      // embedded an absolute loader URL.
      const cwd = await mkdtemp(path.join(tmpdir(), "mockbin-cwd-"));
      try {
        expect(
          await runScriptFile({
            content: `enum Coin { Gold = 7 }
const value: number = Coin.Gold;
console.log(\`gold=\${value} \${process.argv.slice(2).join(",")}\`);`,
            extension: "ts",
            args: ["a", "b"],
            cwd,
          }),
        ).toBe("gold=7 a,b\n");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it("resolves tsx from the script's own package", async () => {
      // Unlike the temp-dir scripts above, the fixture lives inside
      // this package, so the first resolution base (the script's own
      // location) finds tsx; the enum proves the loader transformed it.
      const cleanup = await mockBin("testbin", {
        file: fileURLToPath(
          new URL("./mock-shorthand-fixture.ts", import.meta.url),
        ),
      });
      const result = spawnSync("testbin", ["x"], { encoding: "utf-8" });
      cleanup();
      expect(result.stdout).toBe("fixture gold=7 args=x\n");
    });

    it("loads .tsx files through the same loader", async () => {
      expect(
        await runScriptFile({
          content: 'const value: number = 5; console.log("tsx ok " + value);',
          extension: "tsx",
        }),
      ).toBe("tsx ok 5\n");
    });

    it("runs .js files through node", async () => {
      expect(
        await runScriptFile({
          content: 'console.log("js " + process.argv[2]);',
          extension: "js",
          args: ["arg"],
        }),
      ).toBe("js arg\n");
    });

    it("runs .sh files through bash", async () => {
      expect(
        await runScriptFile({
          content: 'echo "sh $1"',
          extension: "sh",
          args: ["arg"],
        }),
      ).toBe("sh arg\n");
    });

    it("rejects extensions with no known interpreter", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "mockbin-"));
      const scriptPath = path.join(dir, "mock.py");
      await writeFile(scriptPath, 'print("nope")');

      await expect(mockBin("testbin", { file: scriptPath })).rejects.toThrow(
        "no interpreter known",
      );

      await rm(dir, { recursive: true, force: true });
    });

    it("throws when the script file does not exist", async () => {
      await expect(
        mockBin("testbin", { file: "/nonexistent/mock-script.ts" }),
      ).rejects.toThrow("script file not found");
    });

    it("honors the pattern config", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "mockbin-pattern-"));
      const scriptPath = path.join(dir, "mock.js");
      await writeFile(scriptPath, 'console.log("shorthand file mock")');

      const cleanup = await mockBin(
        { binName: "git", pattern: "^git status" },
        { file: scriptPath },
      );

      const statusResult = spawnSync("git", ["status"], { encoding: "utf-8" });
      expect(statusResult.stdout).toBe("shorthand file mock\n");

      const versionResult = spawnSync("git", ["version"], {
        encoding: "utf-8",
      });
      expect(versionResult.stdout).toContain("git version");

      cleanup();
      await rm(dir, { recursive: true, force: true });
    });
  });
});
