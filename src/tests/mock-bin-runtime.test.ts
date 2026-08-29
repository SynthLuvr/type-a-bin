import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCKS_VAR } from "../mock-bin-env.js";
import { resolveTsxImportUrl } from "../mock-bin-tsx.js";

// Exercises the trampoline bootstrap's dispatch (mock-bin-runtime's
// runTrampoline) the way the native launcher does on Windows: Node runs
// a bootstrap script with [node, bootstrap, <mock>.exe, ...args] and
// the registry in the environment. The runtime is platform-neutral, so
// the suite runs everywhere and the Windows CI additionally runs the
// launcher end-to-end (mock-bin-trampoline.test.ts).
const ownPath = fileURLToPath(import.meta.url);
const runtimeUrl = new URL(
  `../mock-bin-runtime${path.extname(ownPath)}`,
  import.meta.url,
).href;

let dir: string;
let driver: string;
let capture: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mockbin-runtime-"));
  // Mirrors the bootstrap mock-bin-windows generates for the temp dir.
  driver = path.join(dir, "mock-bin-trampoline.mjs");
  await writeFile(
    driver,
    `import(${JSON.stringify(runtimeUrl)}).then((runtime) =>\n` +
      `  runtime.runTrampoline(),\n);\n`,
  );
  capture = path.join(dir, "argv.json");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A node-kind mock entry that records what the mock itself observed. */
const writeCaptureEntry = async (
  name: string,
  code: string,
): Promise<string> => {
  const entry = path.join(dir, `${name}.cjs`);
  await writeFile(entry, `${code}\n`);
  return entry;
};

const registryWith = (target: unknown, name = "claude"): NodeJS.ProcessEnv => ({
  ...process.env,
  [MOCKS_VAR]: JSON.stringify({
    targets: { [name]: target },
    runOriginal: { binName: name, originalPath: process.env.PATH ?? "" },
  }),
});

const runTrampoline = (
  invokedExe: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) =>
  spawnSync(process.execPath, [driver, invokedExe, ...args], {
    encoding: "utf-8",
    env,
  });

describe("runTrampoline", () => {
  it("delivers flag-first argv to the mock untouched", async () => {
    const entry = await writeCaptureEntry(
      "flag-first",
      `const { writeFileSync } = require("node:fs");
       writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const args = [
      "--session-id",
      "00000000-0000-0000-0000-000000000000",
      "--append-system-prompt",
      'line one\nline "two"',
      "--print",
    ];

    const result = runTrampoline(
      path.join(dir, "claude.exe"),
      args,
      registryWith({
        kind: "node",
        entry,
        originalPath: process.env.PATH ?? "",
      }),
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(await readFile(capture, "utf-8"))).toEqual(args);
  });

  it("runs the mock with no arguments and never reaches a REPL", async () => {
    const entry = await writeCaptureEntry(
      "no-args",
      `const { writeFileSync } = require("node:fs");
       writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));`,
    );

    const result = runTrampoline(
      path.join(dir, "claude.exe"),
      [],
      registryWith({
        kind: "node",
        entry,
        originalPath: process.env.PATH ?? "",
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(await readFile(capture, "utf-8"))).toEqual([]);
  });

  it("passes stdin, stdout, environment, cwd, and exit codes through", async () => {
    const entry = await writeCaptureEntry(
      "stdio",
      `const chunks = [];
       process.stdin.on("data", (chunk) => chunks.push(chunk));
       process.stdin.on("end", () => {
         const text = Buffer.concat(chunks).toString("utf-8");
         process.stdout.write(process.cwd() + "\\n" + process.env.MOCKBIN_RT_VAR + "\\n" + text);
         process.exit(7);
       });`,
    );
    const workDir = await mkdtemp(path.join(tmpdir(), "mockbin-rt-cwd-"));
    const env = registryWith({
      kind: "node",
      entry,
      originalPath: process.env.PATH ?? "",
    });
    env.MOCKBIN_RT_VAR = "env-value";

    const result = spawnSync(
      process.execPath,
      [driver, path.join(dir, "claude.exe")],
      {
        encoding: "utf-8",
        cwd: workDir,
        input: "stdin payload\n",
        env,
      },
    );

    expect(result.status).toBe(7);
    expect(result.stdout).toBe(`${workDir}\nenv-value\nstdin payload\n`);
  });

  it("forwards pattern misses to the real binary with the original argv", async () => {
    const result = runTrampoline(
      path.join(dir, "no-such-binary-xyz.exe"),
      ["--version"],
      registryWith(
        {
          kind: "node",
          entry: path.join(dir, "unused.cjs"),
          pattern: "^no-such-binary-xyz push",
          originalPath: process.env.PATH ?? "",
        },
        "no-such-binary-xyz",
      ),
    );

    expect(result.status).toBe(127);
    expect(result.stderr).toContain(
      "Real binary 'no-such-binary-xyz' not found",
    );
  });

  it("forwards pattern misses to a resolvable real binary", async () => {
    const env = registryWith(
      {
        kind: "node",
        entry: path.join(dir, "unused.cjs"),
        pattern: "^git push",
        originalPath: process.env.PATH ?? "",
      },
      "git",
    );

    const result = runTrampoline(path.join(dir, "git.exe"), ["--version"], env);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("git version");
  });

  it("runs spawn-kind mocks through their interpreter", async () => {
    const script = path.join(dir, "bash-mock.sh");
    await writeFile(script, `printf '%s\\n' "$1"\ncat\n`);

    const result = spawnSync(
      process.execPath,
      [driver, path.join(dir, "claude.exe"), "positional"],
      {
        encoding: "utf-8",
        input: "from stdin\n",
        env: registryWith({
          kind: "spawn",
          entry: script,
          interpreter: "bash",
          originalPath: process.env.PATH ?? "",
        }),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("positional\nfrom stdin\n");
  });

  it("dispatches the run-original helper with flag-first argv", async () => {
    const env = registryWith({});
    env[MOCKS_VAR] = JSON.stringify({
      targets: {},
      runOriginal: { binName: "git", originalPath: process.env.PATH ?? "" },
    });

    const result = runTrampoline(
      path.join(dir, "mock-a-bin-run-original.exe"),
      ["--version"],
      env,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("git version");
  });

  it("runs the real binary when the registry is absent", async () => {
    const env = { ...process.env };
    delete env[MOCKS_VAR];

    const result = runTrampoline(path.join(dir, "git.exe"), ["--version"], env);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("git version");
  });

  it("loads TypeScript entries through the target's tsx loader URL", async () => {
    const entry = path.join(dir, "entry.ts");
    await writeFile(
      entry,
      `import { writeFileSync } from "node:fs";
         const value: string[] = process.argv.slice(2);
         writeFileSync(${JSON.stringify(capture)}, JSON.stringify(value));
        `,
    );
    // Resolve tsx exactly the way mockBin does; without tsx installed,
    // node's native type stripping still runs the erasable-syntax file.
    const tsxUrl = resolveTsxImportUrl(entry);

    const result = runTrampoline(
      path.join(dir, "claude.exe"),
      ["--flag", "value"],
      registryWith({
        kind: "node",
        entry,
        ...(tsxUrl === null ? {} : { tsxImportUrl: tsxUrl }),
        originalPath: process.env.PATH ?? "",
      }),
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(await readFile(capture, "utf-8"))).toEqual([
      "--flag",
      "value",
    ]);
  });
});
