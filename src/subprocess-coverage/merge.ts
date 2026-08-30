import { existsSync, readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import astV8ToIstanbul from "ast-v8-to-istanbul";
import { parseAstAsync } from "vitest/node";

// Subprocess-coverage plumbing shared by the custom vitest provider
// (provider.ts) and tests of the pipeline itself.
//
// vitest's in-process V8 coverage cannot see code that runs only in a
// spawned child — the mocked binaries, trampolines, preload shims —
// so that code reports as 0% however thoroughly the suite exercises
// it. When RAW_COVERAGE_ENV names a directory (set behind
// `pnpm test:lib`, or by a consumer's own runner), every child that
// inherits the runner's environment gets NODE_V8_COVERAGE pointed at
// it — so Node's profiler writes raw script coverage on exit — and
// NODE_OPTIONS loads coverage-hook.mjs, which records the code each
// child actually executed. Here the two are paired: the raw offsets
// are remapped onto the original sources and merged into vitest's
// coverage map. Without the env var, propagation is off.

const RAW_COVERAGE_ENV = "TYPE_A_BIN_SUBPROCESS_COVERAGE_DIR";
const ROOTS_ENV = "TYPE_A_BIN_SUBPROCESS_COVERAGE_ROOTS";

const TS_EXTENSIONS = [".cts", ".mts", ".ts", ".tsx"];

// The raw-profile directory for this run, or undefined when
// propagation is off.
const rawCoverageDir = (env = process.env): string | undefined => {
  const dir = env[RAW_COVERAGE_ENV];
  return dir === undefined || dir === "" ? undefined : dir;
};

/** Absolute file URL of the observer hook shipped next to this module. */
const coverageHookUrl = (): string =>
  new URL("./coverage-hook.mjs", import.meta.url).href;

// Environment that makes a child write raw profiles and load the
// observer hook. Children inherit the runner's environment by default,
// so applying this to the runner reaches every descendant; spreading
// it into an explicit `env` covers the rest. The hook is prepended so
// it registers before any `--import` already present (a tsx loader, a
// preload) and observes those modules too. Idempotent: existing
// NODE_OPTIONS that already load the hook pass through untouched.
const subprocessCoverageEnv = (
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const rawDir = rawCoverageDir(env);
  if (rawDir === undefined) return {};
  const hook = coverageHookUrl();
  const options = env.NODE_OPTIONS ?? "";
  return {
    NODE_V8_COVERAGE: rawDir,
    NODE_OPTIONS: options.includes(hook)
      ? options
      : `--import ${hook}${options === "" ? "" : ` ${options}`}`,
  };
};

type RawFunctionCoverage = {
  functionName: string;
  ranges: { startOffset: number; endOffset: number; count: number }[];
  isBlockCoverage: boolean;
};

type RawScriptCoverage = { url: string; functions: RawFunctionCoverage[] };

type TransformRecord = { url: string; code: string; map?: unknown };

/** Structural slice of istanbul's CoverageMap that the merge needs. */
type MergeableCoverageMap = { merge(data: unknown): void };

type RemapOptions = Parameters<typeof astV8ToIstanbul>[0];
type RemapSourceMap = NonNullable<RemapOptions["sourceMap"]>;
type RemapFilter = (path: string) => boolean;

/** Parsed-once inputs shared by every child snapshot of a script. */
type PreparedScript = {
  code: string;
  map: RemapSourceMap | undefined;
  ast: Awaited<ReturnType<typeof parseAstAsync>>;
};

const PROFILE_FILE = /^coverage-.*\.json$/;
const TRANSFORM_FILE = /^transforms-.*\.jsonl$/;

// Profile and transform file names are <kind>-<pid>-<suffix>.
const pidOf = (fileName: string): string => fileName.split("-")[1];

// One recorded module per line; a torn trailing line (crash mid-append)
// is skipped.
const readTransformLines = (file: string): TransformRecord[] => {
  const records: TransformRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line === "") continue;
    try {
      records.push(JSON.parse(line) as TransformRecord);
    } catch {
      continue;
    }
  }
  return records.filter((record) => typeof record.url === "string");
};

// Transforms recorded by coverage-hook.mjs; the first record per URL
// wins. Also reports the pids that recorded transforms: raw profiles
// are named coverage-<pid>-…, and every Node process that inherited
// NODE_V8_COVERAGE writes one (helper `node -e` children, tooling
// processes) — only the pids that recorded a transform are
// remappable, the rest are noise.
const readTransforms = (
  dir: string,
): { byUrl: Map<string, TransformRecord>; pids: Set<string> } => {
  const files = readdirSync(dir).filter((name) => TRANSFORM_FILE.test(name));
  const byUrl = new Map<string, TransformRecord>();
  for (const name of files)
    for (const record of readTransformLines(join(dir, name)))
      if (!byUrl.has(record.url)) byUrl.set(record.url, record);
  return { byUrl, pids: new Set(files.map(pidOf)) };
};

// A raw profile Node writes on process exit; an unparseable file
// reads as empty.
const readProfileScripts = (file: string): RawScriptCoverage[] => {
  try {
    const parsed: { result?: RawScriptCoverage[] } = JSON.parse(
      readFileSync(file, "utf8"),
    );
    return parsed.result ?? [];
  } catch {
    return [];
  }
};

// Per-URL function coverages grouped per profile file: each child
// writes its own profile on exit, and each profile must be converted
// on its own — a single conversion over concatenated entries loses
// hits, because a reappearing function name overwrites whatever an
// earlier child's snapshot credited. Merging the per-child results
// through istanbul unions them, and istanbul only distinguishes hit
// (>0) from unhit (0), so the union never flips a covered statement
// back to uncovered.
const readRawProfiles = (
  dir: string,
  pids: Set<string>,
): RawScriptCoverage[][] =>
  readdirSync(dir)
    .filter(
      (name) =>
        PROFILE_FILE.test(name) && (pids.size === 0 || pids.has(pidOf(name))),
    )
    .map((name) => readProfileScripts(join(dir, name)));

const extensionOf = (url: string): string => {
  const base = basename(fileURLToPath(url));
  const at = base.lastIndexOf(".");
  return at <= 0 ? "" : base.slice(at);
};

// Code the merge can parse and remap. A recorded source map (a loader
// like tsx transformed the module) travels with its transpiled code;
// a bare TypeScript source ran through Node's own type stripping,
// whose erasure preserves offsets, so stripping the types again yields
// parseable code whose positions still address the original file.
const toRemappableCode = (
  transform: TransformRecord,
): { code: string; map: RemapSourceMap | undefined } => {
  if (transform.map !== undefined)
    return { code: transform.code, map: transform.map as RemapSourceMap };
  if (!TS_EXTENSIONS.includes(extensionOf(transform.url)))
    return { code: transform.code, map: undefined };
  try {
    return { code: stripTypeScriptTypes(transform.code), map: undefined };
  } catch {
    return { code: transform.code, map: undefined };
  }
};

// Node compiles CommonJS modules inside a wrapper whose closing brace
// outlives the module's own text, so a range can end past the recorded
// code; clamping keeps every offset addressable.
const clampToEnd = (
  functions: RawFunctionCoverage[],
  length: number,
): RawFunctionCoverage[] =>
  functions.map((fn) => ({
    ...fn,
    ranges: fn.ranges.map((range) => ({
      ...range,
      endOffset: Math.min(range.endOffset, length),
    })),
  }));

// Everything needed to convert one script's raw offsets, prepared
// once per URL. Undefined when the script is out of scope or
// unparseable — a single bad module must not sink the whole report.
const prepareScript = async (
  url: string,
  transform: TransformRecord,
  isIncluded: RemapFilter,
): Promise<PreparedScript | undefined> => {
  let path: string;
  try {
    path = fileURLToPath(decodeURIComponent(url));
  } catch {
    return undefined;
  }
  if (!existsSync(path) || !isIncluded(path)) return undefined;
  try {
    const { code, map } = toRemappableCode(transform);
    return { code, map, ast: await parseAstAsync(code) };
  } catch {
    return undefined;
  }
};

// Converts one child's snapshot of a prepared script into istanbul
// data. Undefined when the conversion fails — one bad profile must
// not sink the whole merge.
const convertSnapshot = async (
  url: string,
  functions: RawFunctionCoverage[],
  prepared: PreparedScript,
) => {
  try {
    return await astV8ToIstanbul({
      code: prepared.code,
      sourceMap: prepared.map,
      coverage: {
        url,
        functions: clampToEnd(functions, prepared.code.length),
      },
      ast: prepared.ast as RemapOptions["ast"],
    });
  } catch {
    return undefined;
  }
};

// Merges raw subprocess coverage into `coverageMap`. `isIncluded` is
// the provider's include/exclude filter, so the merge respects
// coverage.include exactly like in-process collection. URLs without a
// recorded transform (in-process worker coverage, helper scripts) are
// skipped: their offsets belong to a different transform pipeline, and
// vitest already handles the in-process ones itself. Returns the
// number of files that contributed coverage.
const mergeSubprocessCoverage = async (
  coverageMap: MergeableCoverageMap,
  rawDir: string,
  isIncluded: RemapFilter,
): Promise<number> => {
  if (!existsSync(rawDir)) return 0;
  const { byUrl: transforms, pids } = readTransforms(rawDir);
  if (transforms.size === 0) return 0;
  const scripts = readRawProfiles(rawDir, pids).flat();
  let merged = 0;
  for (const [url, transform] of transforms) {
    const prepared = await prepareScript(url, transform, isIncluded);
    if (prepared === undefined) continue;
    let contributed = false;
    for (const script of scripts) {
      if (script.url !== url) continue;
      const data = await convertSnapshot(url, script.functions, prepared);
      if (data === undefined) continue;
      coverageMap.merge(data);
      contributed = true;
    }
    if (contributed) merged += 1;
  }
  return merged;
};

export type { MergeableCoverageMap, RemapFilter };
export {
  coverageHookUrl,
  mergeSubprocessCoverage,
  RAW_COVERAGE_ENV,
  ROOTS_ENV,
  rawCoverageDir,
  subprocessCoverageEnv,
};
