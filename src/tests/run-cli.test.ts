import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTsxImportUrl } from "../mock-bin-tsx.js";
import {
  coverageHookUrl,
  RAW_COVERAGE_ENV,
  ROOTS_ENV,
  stripCoverageHookFromNodeOptions,
} from "../subprocess-coverage/index.js";
import { runCliAsMain } from "../subprocess-coverage/run-cli.js";

// End-to-end checks of runCliAsMain, the launcher entry-point behind
// the subprocess-coverage/run-cli subpath: a project-style bin/*.mjs
// imports the facade and hands it the CLI entry, and each test spawns
// that launcher as a real child to verify — from the outside — what a
// launcher used to hand-roll from the README: argv repositioning, the
// restart-versus-in-process decision, the scrubbed NODE_OPTIONS, and
// the observer's ordering above the tsx loader.

// The fixtures run from the source tree, so realpaths must pair with
// the URLs the observer records (macOS /tmp aliases, Windows
// short names).
const srcRoot = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const runCliUrl = pathToFileURL(
  join(srcRoot, "subprocess-coverage", "run-cli.ts"),
).href;

// The launcher child imports the library from source, so it needs tsx
// on its own argv to resolve the .js specifiers to .ts files. A real
// consumer imports the compiled dist, where node alone suffices.
const tsxImportUrl = resolveTsxImportUrl(join(srcRoot, "mock-bin-runtime.ts"));

const HOOK = coverageHookUrl();

/** JSON the CLI fixtures print before exiting. */
type CliReport = {
  args: string[];
  argv1: string;
  nodeOptions: string;
  restarted: boolean;
};

/** The CommonJS fixture's variant, with require.main's verdict. */
type CjsReport = CliReport & { isMain: boolean };

type RecordedTransform = { code: string; map?: unknown };

// A TypeScript entry carrying an erasable annotation: an observer
// ordered above the tsx loader records it without the annotation plus
// tsx's inline source map; one registered below it records the source
// exactly as written.
const writeTsEntry = (dir: string): string => {
  const entry = join(dir, "cli.ts");
  writeFileSync(
    entry,
    [
      "const probe = (args: string[]): string =>",
      "  JSON.stringify({",
      "    args,",
      '    argv1: process.argv[1] ?? "",',
      '    nodeOptions: process.env.NODE_OPTIONS ?? "",',
      `    restarted: process.execArgv.includes(${JSON.stringify(HOOK)}),`,
      "  });",
      "process.stdout.write(probe(process.argv.slice(2)));",
      "",
    ].join("\n"),
  );
  return entry;
};

const writeCjsEntry = (dir: string): string => {
  const entry = join(dir, "cli.cjs");
  writeFileSync(
    entry,
    [
      "process.stdout.write(",
      "  JSON.stringify({",
      "    args: process.argv.slice(2),",
      '    argv1: process.argv[1] ?? "",',
      "    isMain: require.main === module,",
      `    restarted: process.execArgv.includes(${JSON.stringify(HOOK)}),`,
      "  }),",
      ");",
      "",
    ].join("\n"),
  );
  return entry;
};

// The bin/*.mjs shape: import the facade, hand it the entry.
const writeLauncher = (dir: string, entrySpecifier: string): string => {
  const launcher = join(dir, "launcher.mjs");
  writeFileSync(
    launcher,
    [
      `import { runCliAsMain } from ${JSON.stringify(runCliUrl)};`,
      `await runCliAsMain(${entrySpecifier});`,
      "",
    ].join("\n"),
  );
  return launcher;
};

const runLauncher = (
  launcher: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => {
  expect(tsxImportUrl).not.toBeNull();
  return spawnSync(
    process.execPath,
    ["--import", tsxImportUrl ?? "", launcher, ...args],
    { encoding: "utf-8", env },
  );
};

// A plain environment, the way a launcher runs outside any test run:
// no propagation variables, no observer in NODE_OPTIONS.
const plainEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env[RAW_COVERAGE_ENV];
  delete env.NODE_V8_COVERAGE;
  delete env[ROOTS_ENV];
  const options = stripCoverageHookFromNodeOptions(env.NODE_OPTIONS ?? "");
  if (options === "") delete env.NODE_OPTIONS;
  else env.NODE_OPTIONS = options;
  return env;
};

// The spawning side's environment under propagation: raw directory
// named, profiles pointed at it, and the observer in NODE_OPTIONS only
// when hook is true — exactly what subprocessCoverageEnv() produces.
const propagationEnv = (
  rawDir: string,
  roots: string | undefined,
  hook: boolean,
): NodeJS.ProcessEnv => {
  const options = stripCoverageHookFromNodeOptions(
    process.env.NODE_OPTIONS ?? "",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_V8_COVERAGE: rawDir,
    NODE_OPTIONS: hook
      ? [options, `--import ${HOOK}`].filter((part) => part !== "").join(" ")
      : options,
    [RAW_COVERAGE_ENV]: rawDir,
  };
  if (roots === undefined) delete env[ROOTS_ENV];
  else env[ROOTS_ENV] = roots;
  return env;
};

// Every transform record the observer children wrote into rawDir.
const recordedModules = (rawDir: string): RecordedTransform[] => {
  const records: RecordedTransform[] = [];
  for (const name of readdirSync(rawDir))
    if (name.startsWith("transforms-"))
      for (const line of readFileSync(join(rawDir, name), "utf8").split("\n"))
        if (line !== "") records.push(JSON.parse(line) as RecordedTransform);
  return records;
};

// The entry must be recorded as tsx's transpiled output with its
// inline source map — the record whose offsets match the raw profile.
const expectTranspiledEntry = (rawDir: string): void => {
  const matching = recordedModules(rawDir).filter((record) =>
    record.code.includes("const probe"),
  );
  expect(matching.length).toBeGreaterThan(0);
  for (const record of matching) {
    expect(record.map).toBeTruthy();
    expect(record.code).not.toContain(": string");
  }
};

describe("runCliAsMain", () => {
  it("runs a TypeScript entry as the main module with repositioned argv", () => {
    const dir = mkdtempSync(join(srcRoot, ".run-cli-plain-"));
    try {
      const entry = writeTsEntry(dir);
      const launcher = writeLauncher(
        dir,
        'new URL("./cli.ts", import.meta.url)',
      );
      const result = runLauncher(launcher, ["alpha", "beta"], plainEnv());
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as CliReport;
      expect(report.args).toEqual(["alpha", "beta"]);
      expect(report.argv1).toBe(entry);
      expect(report.restarted).toBe(false);
      expect(report.nodeOptions).not.toContain(HOOK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits with the exit code the entry set", () => {
    const dir = mkdtempSync(join(srcRoot, ".run-cli-exit-"));
    try {
      writeFileSync(join(dir, "cli.ts"), "process.exitCode = 7;\n");
      const launcher = writeLauncher(
        dir,
        'new URL("./cli.ts", import.meta.url)',
      );
      const result = runLauncher(launcher, [], plainEnv());
      expect(result.stderr).toBe("");
      expect(result.status).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restarts ordered when the inherited NODE_OPTIONS carries the hook", () => {
    const rawDir = mkdtempSync(join(tmpdir(), "type-a-bin-runcli-restart-"));
    const dir = mkdtempSync(join(srcRoot, ".run-cli-restart-"));
    try {
      writeTsEntry(dir);
      const launcher = writeLauncher(
        dir,
        'new URL("./cli.ts", import.meta.url)',
      );
      const result = runLauncher(
        launcher,
        ["pr", "list"],
        propagationEnv(rawDir, dir, true),
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as CliReport;
      expect(report.args).toEqual(["pr", "list"]);
      // The entry ran in the restarted child: the observer sits on its
      // execArgv, and the inherited NODE_OPTIONS entry is gone.
      expect(report.restarted).toBe(true);
      expect(report.nodeOptions).not.toContain(HOOK);
      expectTranspiledEntry(rawDir);
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports the observer in-process when NODE_OPTIONS has no hook", () => {
    // Under the repository's own coverage gate the child inherits the
    // runner's raw-profile directory, so this launcher run lands in the
    // merged report — credited through the transpiled records the
    // in-process observer writes after tsx. A standalone run points
    // at a scratch directory instead.
    const inherited = process.env[RAW_COVERAGE_ENV] ?? "";
    const scratch =
      inherited === ""
        ? mkdtempSync(join(tmpdir(), "type-a-bin-runcli-inproc-"))
        : undefined;
    const rawDir = scratch ?? inherited;
    const dir = mkdtempSync(join(srcRoot, ".run-cli-inproc-"));
    try {
      writeTsEntry(dir);
      const launcher = writeLauncher(
        dir,
        'new URL("./cli.ts", import.meta.url)',
      );
      const result = runLauncher(
        launcher,
        ["build"],
        propagationEnv(rawDir, undefined, false),
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as CliReport;
      expect(report.args).toEqual(["build"]);
      expect(report.restarted).toBe(false);
      // Same ordering guarantee without the second process: the entry
      // is still recorded as tsx's transpiled output.
      expectTranspiledEntry(rawDir);
    } finally {
      if (scratch !== undefined)
        rmSync(scratch, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calls the facade in-process, repositioning argv around the entry", async () => {
    // A launcher's own process loads this module before any
    // correctly-ordered observer can register, so no child profile can
    // credit it — the worker's in-process collection sees it instead.
    // Global state the call touches is saved and restored around it.
    const entry = realpathSync(
      join(srcRoot, "tests", "run-cli-entry-fixture.mjs"),
    );
    const globals = globalThis as typeof globalThis & {
      __runCliEntryArgs?: string[];
    };
    const savedArgv = [...process.argv];
    const savedEnv = { ...process.env };
    try {
      // The in-process path must neither fire the observer import (the
      // worker is not a child under propagation) nor a restart.
      delete process.env[RAW_COVERAGE_ENV];
      process.env.NODE_OPTIONS = stripCoverageHookFromNodeOptions(
        process.env.NODE_OPTIONS ?? "",
      );
      process.argv.length = 1;
      process.argv.push("launcher.mjs", "alpha");
      await runCliAsMain(new URL(pathToFileURL(entry).href));
      expect(process.argv[1]).toBe(entry);
      expect(process.argv.slice(2)).toEqual(["alpha"]);
      expect(globals.__runCliEntryArgs).toEqual(["alpha"]);

      // The string form repositions the same way; the entry module
      // itself runs only once per process, however often it is loaded.
      process.argv.length = 1;
      process.argv.push("runner", "beta");
      await runCliAsMain(entry);
      expect(process.argv[1]).toBe(entry);
      expect(process.argv.slice(2)).toEqual(["beta"]);
      expect(globals.__runCliEntryArgs).toEqual(["alpha"]);
    } finally {
      process.argv.length = 1;
      process.argv.push(...savedArgv.slice(1));
      for (const key of Object.keys(process.env))
        if (!(key in savedEnv)) delete process.env[key];
      for (const [key, value] of Object.entries(savedEnv))
        process.env[key] = value;
    }
  });

  it("loads a CommonJS entry with require.main set, from a path string", () => {
    const rawDir = mkdtempSync(join(tmpdir(), "type-a-bin-runcli-cjs-"));
    const dir = mkdtempSync(join(srcRoot, ".run-cli-cjs-"));
    try {
      const entry = writeCjsEntry(dir);
      const launcher = writeLauncher(dir, JSON.stringify(entry));
      const result = runLauncher(
        launcher,
        ["--flag", "x"],
        propagationEnv(rawDir, dir, true),
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as CjsReport;
      expect(report.args).toEqual(["--flag", "x"]);
      expect(report.argv1).toBe(entry);
      expect(report.isMain).toBe(true);
      // No loader is involved, so the hook already in NODE_OPTIONS
      // needs no restart — the startup registration observes the
      // entry as-is.
      expect(report.restarted).toBe(false);
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
