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
import { mockBin } from "../mock-bin.js";
import {
  coverageHookUrl,
  mergeSubprocessCoverage,
  RAW_COVERAGE_ENV,
  ROOTS_ENV,
  rawCoverageDir,
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

describe("subprocess coverage propagation", () => {
  it("counts the mocked binary's process in a merged report", async () => {
    const rawDir = mkdtempSync(path.join(tmpdir(), "type-a-bin-subcov-"));
    try {
      const cleanup = await mockBin("covbin", {
        stdout: ["from the child"],
        exitCode: 3,
      });
      try {
        // Composed after mockBin: the spawn environment must carry the
        // PATH entry the mock just installed, plus the scratch
        // propagation settings instead of any outer run's.
        const env = {
          ...process.env,
          [RAW_COVERAGE_ENV]: rawDir,
          [ROOTS_ENV]: srcRoot,
          ...subprocessCoverageEnv({
            ...process.env,
            [RAW_COVERAGE_ENV]: rawDir,
            [ROOTS_ENV]: srcRoot,
          }),
        };
        const result = spawnSync("covbin", ["pr", "list"], {
          encoding: "utf-8",
          env,
        });
        expect(result.stdout).toBe("from the child\n");
        expect(result.status).toBe(3);
      } finally {
        cleanup();
      }

      const coverageMap = createCoverageMap();
      const merged = await mergeSubprocessCoverage(
        coverageMap,
        rawDir,
        (file) => file === runtimePath,
      );
      expect(merged).toBeGreaterThan(0);

      const fileCoverage = coverageMap.fileCoverageFor(runtimePath);
      expect(fileCoverage).toBeDefined();

      // Line coverage keyed by 1-based line number: the stdout write
      // only executes inside the mocked binary's own process.
      const writeLine = lineNumberOf(
        runtimePath,
        "process.stdout.write(`${line}",
      );
      const lineCoverage = fileCoverage.getLineCoverage();
      expect(lineCoverage[writeLine]).toBeGreaterThan(0);
      expect(Object.values(lineCoverage).some((count) => count > 0)).toBe(true);
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
    }
  });

  it("remaps a tsx-loaded script through its inline source map", async () => {
    const rawDir = mkdtempSync(path.join(tmpdir(), "type-a-bin-subcov-tsx-"));
    // The script lives under a real project-style path, not the OS
    // temp directory: runner temp directories can carry short-name
    // path aliases the merge's exact-URL bookkeeping cannot pair, and
    // a project tree is where transpiled sources actually live.
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

      const cleanup = await mockBin("covtsx", { file: script });
      try {
        const env = {
          ...process.env,
          [RAW_COVERAGE_ENV]: rawDir,
          [ROOTS_ENV]: scriptDir,
          ...subprocessCoverageEnv({
            ...process.env,
            [RAW_COVERAGE_ENV]: rawDir,
            [ROOTS_ENV]: scriptDir,
          }),
        };
        const result = spawnSync("covtsx", [], { encoding: "utf-8", env });
        expect(result.stdout).toBe("42\n");
      } finally {
        cleanup();
      }

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

  it("survives torn transform lines and unparseable profiles", async () => {
    const rawDir = mkdtempSync(path.join(tmpdir(), "type-a-bin-subcov-noise-"));
    try {
      // A behaviour mock runs as Node and loads the library's runtime
      // module, so the child leaves both artifact kinds behind.
      const cleanup = await mockBin("covnoise", { stdout: ["one line"] });
      try {
        const env = {
          ...process.env,
          [RAW_COVERAGE_ENV]: rawDir,
          [ROOTS_ENV]: srcRoot,
          ...subprocessCoverageEnv({
            ...process.env,
            [RAW_COVERAGE_ENV]: rawDir,
            [ROOTS_ENV]: srcRoot,
          }),
        };
        const result = spawnSync("covnoise", [], { encoding: "utf-8", env });
        expect(result.stdout).toBe("one line\n");
      } finally {
        cleanup();
      }

      // A crash mid-append leaves a torn trailing line behind; a killed
      // child can leave a truncated profile. Neither may sink the
      // merge for the artifacts that are intact.
      const transformFiles = readdirSync(rawDir).filter((name) =>
        /^transforms-.*\.jsonl$/.test(name),
      );
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
    expect(enabled.NODE_OPTIONS).toContain(`--import ${coverageHookUrl()}`);

    const again = subprocessCoverageEnv({
      [RAW_COVERAGE_ENV]: "/tmp/raw",
      NODE_OPTIONS: enabled.NODE_OPTIONS,
    });
    expect(again.NODE_OPTIONS).toBe(enabled.NODE_OPTIONS);
  });
});
