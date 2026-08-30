import { spawnSync } from "node:child_process";
import {
  appendFileSync,
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
import { fileURLToPath } from "node:url";
import { createCoverageMap } from "istanbul-lib-coverage";
import { describe, expect, it } from "vitest";
import { type MockBinCleanup, mockBin } from "../mock-bin.js";
import { MOCKS_VAR } from "../mock-bin-env.js";
import { resolveTsxImportUrl } from "../mock-bin-tsx.js";
import {
  coverageHookUrl,
  hookPresentInNodeOptions,
  mergeSubprocessCoverage,
  RAW_COVERAGE_ENV,
  ROOTS_ENV,
  rawCoverageDir,
  stripCoverageHookFromNodeOptions,
  subprocessCoverageEnv,
} from "../subprocess-coverage/index.js";

// End-to-end check of the subprocess-coverage pipeline itself: install
// a real behaviour mock, invoke it as a real spawned binary with
// propagation pointed at a scratch raw-profile directory, then merge
// what the child wrote into a real coverage map. The assertions read
// the library module that only ever runs inside the mocked binary's
// process — without propagation it has no coverage at all, and the
// merge reports zero files.

// Node's ESM loader reports module URLs by their real path (Windows
// short-name aliases, macOS /tmp symlinks), so every path the merge
// filters or looks up must match that form.
const srcRoot = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const runtimePath = path.join(srcRoot, "mock-bin-behaviour-runtime.ts");

/** 1-based line number of the first source line containing `needle`. */
const lineNumberOf = (file: string, needle: string): number => {
  const at = readFileSync(file, "utf8")
    .split("\n")
    .findIndex((line) => line.includes(needle));
  return at + 1;
};

// Spawn environment carrying the scratch propagation settings instead
// of any outer run's. Must be composed after mockBin so it also
// carries the PATH entry the mock just installed.
const propagationEnv = (rawDir: string, roots: string) => {
  const env = {
    ...process.env,
    [RAW_COVERAGE_ENV]: rawDir,
    [ROOTS_ENV]: roots,
  };
  return { ...env, ...subprocessCoverageEnv(env) };
};

/** One transform record as the observer hook wrote it. */
type RecordedTransform = { code: string; map?: { mappings: string } };

/** The transform-record files the children wrote into `rawDir`. */
const transformRecordFiles = (rawDir: string): string[] =>
  readdirSync(rawDir).filter((name) => /^transforms-.*\.jsonl$/.test(name));

/** Every transform record the children wrote into `rawDir`, parsed. */
const recordedTransforms = (rawDir: string): RecordedTransform[] =>
  transformRecordFiles(rawDir)
    .flatMap((name) => readFileSync(join(rawDir, name), "utf8").split("\n"))
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordedTransform);

// An observer ordered after the loader records the transpiled output
// with its inline source map; one registered before it records
// pre-transform source — no map, type annotations intact.
const expectTranspiledRecord = (
  transforms: RecordedTransform[],
  marker: string,
  typeAnnotation: string,
): void => {
  const matching = transforms.filter((transform) =>
    transform.code.includes(marker),
  );
  expect(matching.length).toBeGreaterThan(0);
  for (const transform of matching) {
    expect(transform.map?.mappings).toBeTruthy();
    expect(transform.code).not.toContain(typeAnnotation);
  }
};

// Spawns an installed mock once as a real binary and always
// uninstalls it again.
const runMockedBin = (
  name: string,
  args: string[],
  rawDir: string,
  roots: string,
  cleanup: MockBinCleanup,
) => {
  try {
    return spawnSync(name, args, {
      encoding: "utf-8",
      env: propagationEnv(rawDir, roots),
    });
  } finally {
    cleanup();
  }
};

// Reproduces the native trampoline launcher's invocation shape: a
// CommonJS bootstrap calls runTrampoline, argv[2] names the invoked
// mock, the registry travels in MOCKS_VAR, and the child starts with
// the caller's NODE_OPTIONS.
const runTrampolineDispatch = (
  scriptDir: string,
  rawDir: string,
  entryLines: string[],
  nodeOptions: string,
) => {
  writeFileSync(path.join(scriptDir, "entry.ts"), entryLines.join("\n"));
  const entry = realpathSync(path.join(scriptDir, "entry.ts"));
  const tsxImportUrl = resolveTsxImportUrl(entry);
  expect(tsxImportUrl).not.toBeNull();

  const bootPath = path.join(scriptDir, "trampoline-boot.cjs");
  writeFileSync(
    bootPath,
    `require(${JSON.stringify(
      path.join(srcRoot, "mock-bin-runtime.ts"),
    )}).runTrampoline();\n`,
  );
  const registry = {
    targets: {
      covtrampoline: {
        kind: "node",
        entry,
        tsxImportUrl: tsxImportUrl ?? undefined,
        originalPath: "",
      },
    },
  };
  return spawnSync(
    process.execPath,
    [bootPath, path.join(scriptDir, "covtrampoline.exe")],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        NODE_V8_COVERAGE: rawDir,
        [RAW_COVERAGE_ENV]: rawDir,
        [ROOTS_ENV]: scriptDir,
        [MOCKS_VAR]: JSON.stringify(registry),
        NODE_OPTIONS: nodeOptions,
      },
    },
  );
};

describe("subprocess coverage propagation", () => {
  it("counts the mocked binary's process in a merged report", async () => {
    const rawDir = mkdtempSync(path.join(tmpdir(), "type-a-bin-subcov-"));
    try {
      const install = await mockBin("covbin", {
        stdout: ["from the child"],
        exitCode: 3,
      });
      const result = runMockedBin(
        "covbin",
        ["pr", "list"],
        rawDir,
        srcRoot,
        install,
      );
      expect(result.stdout).toBe("from the child\n");
      expect(result.status).toBe(3);

      const coverageMap = createCoverageMap();
      const merged = await mergeSubprocessCoverage(
        coverageMap,
        rawDir,
        (file) => file === runtimePath,
      );
      expect(merged).toBeGreaterThan(0);

      // Line coverage is keyed by 1-based line number; the stdout
      // write only executes inside the mocked binary's own process.
      const writeLine = lineNumberOf(
        runtimePath,
        "process.stdout.write(`${line}",
      );
      const lineCoverage = coverageMap
        .fileCoverageFor(runtimePath)
        .getLineCoverage();
      expect(lineCoverage[writeLine]).toBeGreaterThan(0);
      expect(Object.values(lineCoverage).some((count) => count > 0)).toBe(true);
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
    }
  });

  it("remaps a tsx-loaded script through its inline source map", async () => {
    const rawDir = mkdtempSync(path.join(tmpdir(), "type-a-bin-subcov-tsx-"));
    // The script lives under a project-style path, not the OS temp
    // directory: temp directories can carry short-name path aliases
    // the merge's exact-URL bookkeeping cannot pair, and a project
    // tree is where transpiled sources actually live.
    const scriptDir = mkdtempSync(path.join(srcRoot, ".subcov-src-"));
    try {
      const answerLine = 5;
      writeFileSync(
        path.join(scriptDir, "script.ts"),
        [
          "// padding so coverage lines are stable",
          "const pick = (): number => {",
          "  return 41 + 1;",
          "};",
          "const answer = pick();",
          "console.log(answer);",
          "",
        ].join("\n"),
      );
      const script = realpathSync(path.join(scriptDir, "script.ts"));

      const install = await mockBin("covtsx", { file: script });
      const result = runMockedBin("covtsx", [], rawDir, scriptDir, install);
      expect(result.stdout).toBe("42\n");

      // Ordered after the tsx loader, the observer records the
      // transpiled output together with tsx's inline source map — the
      // only recorded code whose offsets match the raw profile.
      expectTranspiledRecord(
        recordedTransforms(rawDir),
        "const answer",
        ": number",
      );

      // The tsx loader transpiles the script (esbuild output, not the
      // source), so only the recorded inline source map can put the
      // hits back onto the original lines.
      const coverageMap = createCoverageMap();
      const merged = await mergeSubprocessCoverage(
        coverageMap,
        rawDir,
        (file) => file === script,
      );
      expect(merged).toBeGreaterThan(0);
      const lineCoverage = coverageMap
        .fileCoverageFor(script)
        .getLineCoverage();
      expect(lineCoverage[answerLine]).toBeGreaterThan(0);
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  it("orders the observer for trampoline-dispatched TypeScript targets", () => {
    const rawDir = mkdtempSync(path.join(tmpdir(), "type-a-bin-subcov-tr-"));
    // Project-tree path (see the tsx test above) so realpaths pair.
    const scriptDir = mkdtempSync(path.join(srcRoot, ".subcov-tr-"));
    try {
      // The runner's NODE_OPTIONS already loads the observer — exactly
      // the inheritance that would otherwise register it before tsx.
      const result = runTrampolineDispatch(
        scriptDir,
        rawDir,
        ['const note = (): string => "reexec";', "console.log(note());", ""],
        `--import ${coverageHookUrl()}`,
      );
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("reexec\n");
      expect(result.status).toBe(0);

      // The restart must have put the observer after tsx: the recorded
      // entry is the transpiled output, not the pre-transform source
      // the startup-ordered observer would have written.
      expectTranspiledRecord(
        recordedTransforms(rawDir),
        "const note",
        ": string",
      );
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  it("registers the observer in-process when NODE_OPTIONS has no hook", () => {
    const rawDir = mkdtempSync(path.join(tmpdir(), "type-a-bin-subcov-ip-"));
    // Project-tree path (see the tsx test above) so realpaths pair.
    const scriptDir = mkdtempSync(path.join(srcRoot, ".subcov-ip-"));
    try {
      // The entry reports which path took it: a restart carries the
      // ordered --import pair in execArgv, the in-process path none.
      // A launcher that owns the observer's ordering itself strips the
      // hook from the inherited NODE_OPTIONS; other options stay.
      const result = runTrampolineDispatch(
        scriptDir,
        rawDir,
        [
          "const note = (): string =>",
          '  process.execArgv.length === 0 ? "inproc" : "restart";',
          "console.log(note());",
          "",
        ],
        stripCoverageHookFromNodeOptions(process.env.NODE_OPTIONS ?? ""),
      );
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("inproc\n");
      expect(result.status).toBe(0);

      // Same ordering guarantee as the restart: the recorded entry is
      // tsx's transpiled output with its inline source map.
      expectTranspiledRecord(
        recordedTransforms(rawDir),
        "const note",
        ": string",
      );

      // Exactly one observer wrote transform records — no restarted
      // second process existed to write a second file.
      expect(transformRecordFiles(rawDir)).toHaveLength(1);
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  it("survives torn transform lines and unparseable profiles", async () => {
    const rawDir = mkdtempSync(path.join(tmpdir(), "type-a-bin-subcov-noise-"));
    try {
      // A behaviour mock runs as Node and loads the library's runtime
      // module, so the child leaves both artifact kinds behind.
      const install = await mockBin("covnoise", { stdout: ["one line"] });
      const result = runMockedBin("covnoise", [], rawDir, srcRoot, install);
      expect(result.stdout).toBe("one line\n");

      // A crash mid-append leaves a torn trailing line behind; a
      // killed child can leave a truncated profile. Neither may sink
      // the merge for the artifacts that are intact.
      const transformFiles = transformRecordFiles(rawDir);
      expect(transformFiles.length).toBeGreaterThan(0);
      for (const name of transformFiles)
        appendFileSync(join(rawDir, name), '{"url": "tor');
      const pid = transformFiles[0].split("-")[1];
      writeFileSync(join(rawDir, `coverage-${pid}-bogus.json`), "{not json");

      const coverageMap = createCoverageMap();
      const merged = await mergeSubprocessCoverage(
        coverageMap,
        rawDir,
        (file) => file === runtimePath,
      );
      expect(merged).toBeGreaterThan(0);
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
    }
  });

  it("composes the child environment idempotently and only when on", () => {
    expect(subprocessCoverageEnv({})).toEqual({});
    expect(rawCoverageDir({})).toBeUndefined();

    const enabled = subprocessCoverageEnv({
      [RAW_COVERAGE_ENV]: "/tmp/raw",
    });
    expect(enabled.NODE_V8_COVERAGE).toBe("/tmp/raw");
    expect(enabled.NODE_OPTIONS).toBe(`--import ${coverageHookUrl()}`);

    const again = subprocessCoverageEnv({
      [RAW_COVERAGE_ENV]: "/tmp/raw",
      NODE_OPTIONS: enabled.NODE_OPTIONS,
    });
    expect(again.NODE_OPTIONS).toBe(enabled.NODE_OPTIONS);
  });

  it("orders the observer after loaders already in NODE_OPTIONS", () => {
    // registerHooks chains are LIFO, so the hook must register after a
    // loader already present — appended, never prepended — or it
    // records pre-transform source against transpiled offsets.
    const loader = "--import /tmp/project-loader.mjs";
    const ordered = subprocessCoverageEnv({
      [RAW_COVERAGE_ENV]: "/tmp/raw",
      NODE_OPTIONS: `${loader} --max-old-space-size=4096`,
    });
    expect(ordered.NODE_OPTIONS).toBe(
      `${loader} --max-old-space-size=4096 --import ${coverageHookUrl()}`,
    );

    // Children that place the hook themselves must drop the inherited
    // entry, or its earlier registration silently wins.
    expect(stripCoverageHookFromNodeOptions(ordered.NODE_OPTIONS ?? "")).toBe(
      `${loader} --max-old-space-size=4096`,
    );
    expect(
      stripCoverageHookFromNodeOptions(
        `--import=${coverageHookUrl()} ${loader}`,
      ),
    ).toBe(loader);
    expect(stripCoverageHookFromNodeOptions("")).toBe("");
  });

  it("detects a startup-registered observer in every --import spelling", () => {
    const hook = coverageHookUrl();
    expect(hookPresentInNodeOptions(`--import ${hook}`)).toBe(true);
    expect(hookPresentInNodeOptions(`--import=${hook}`)).toBe(true);
    // A launcher's own loader and unrelated options do not count.
    expect(hookPresentInNodeOptions("--import /tmp/project-loader.mjs")).toBe(
      false,
    );
    expect(hookPresentInNodeOptions("--max-old-space-size=4096")).toBe(false);
    expect(hookPresentInNodeOptions("")).toBe(false);
  });
});
