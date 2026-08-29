import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  link,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCKS_VAR, withoutMocks } from "../mock-bin-env.js";

// Exercises the preload the way mockBin installs it on Windows: a shim
// executable (a link of node named like the mocked bin) plus the mock
// registry in the environment. The preload is plain TypeScript that
// imports builtins only, so node loads the .ts form directly and the
// suite runs on every platform.
const preloadUrl = pathToFileURL(
  fileURLToPath(new URL("../mock-bin-preload.ts", import.meta.url)),
).href;
const shimName = process.platform === "win32" ? "testbin.exe" : "testbin";

let dir: string;
let shim: string;
let shimEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mockbin-preload-"));
  shim = path.join(dir, shimName);
  try {
    await link(process.execPath, shim);
  } catch {
    // Different volume than the node install: copy a real executable.
    await copyFile(process.execPath, shim);
    await chmod(shim, 0o755);
  }
  const entry = path.join(dir, "mock.cjs");
  await writeFile(entry, 'console.log("preload mock ran");\n');

  const registry = {
    targets: {
      testbin: { kind: "node", entry, originalPath: process.env.PATH ?? "" },
    },
  };
  const imports = [`--import ${preloadUrl}`];
  const previousNodeOptions = process.env.NODE_OPTIONS;
  shimEnv = {
    ...process.env,
    [MOCKS_VAR]: JSON.stringify(registry),
    NODE_OPTIONS:
      previousNodeOptions === undefined || previousNodeOptions === ""
        ? imports.join(" ")
        : `${imports.join(" ")} ${previousNodeOptions}`,
  };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const runShim = (args: string[], env: NodeJS.ProcessEnv = shimEnv) =>
  spawnSync(shim, args, { encoding: "utf-8", env });

describe("mock-bin-preload", () => {
  it("redirects a shim invocation to the mock entry", () => {
    const result = runShim([]);

    expect(result.stdout).toBe("preload mock ran\n");
  });

  it("runs -e snippets instead of the mock", () => {
    const result = runShim(["-e", 'console.log("eval ran")']);

    expect(result.stdout).toBe("eval ran\n");
    expect(result.stderr).toBe("");
  });

  it("runs --eval= snippets instead of the mock", () => {
    const result = runShim(["--eval=console.log('eval= ran')"]);

    expect(result.stdout).toBe("eval= ran\n");
  });

  it("runs -p snippets instead of the mock", () => {
    const result = runShim(["-p", '"print ran"']);

    expect(result.stdout).toBe("print ran\n");
  });

  it("runs --print snippets instead of the mock", () => {
    const result = runShim(["--print", '"print ran"']);

    expect(result.stdout).toBe("print ran\n");
  });

  it("does not intercept --print= runs", () => {
    // Node itself ignores the code in the `--print=` form (it prints
    // "undefined"), but the run still has no entry to redirect, so the
    // preload must leave it to node rather than swallow it.
    const result = runShim(['--print="print= ran"']);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("preload mock ran");
  });
});

describe("withoutMocks", () => {
  it("removes the mock registry from a copy of the environment", () => {
    const env = { [MOCKS_VAR]: "{}", PATH: "/bin" } as NodeJS.ProcessEnv;
    const child = withoutMocks(env);

    expect(child[MOCKS_VAR]).toBe(undefined);
    expect(child.PATH).toBe("/bin");
    expect(env[MOCKS_VAR]).toBe("{}");
  });

  it("leaves an environment without a registry unchanged", () => {
    const env = { PATH: "/bin" } as NodeJS.ProcessEnv;

    expect(withoutMocks(env)).toEqual({ PATH: "/bin" });
  });

  it("lets a spawned shim escape interception", () => {
    const result = runShim(
      ["-e", 'console.log("escaped")'],
      withoutMocks(shimEnv),
    );

    expect(result.stdout).toBe("escaped\n");
  });
});
