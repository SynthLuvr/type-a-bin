import { existsSync, readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import astV8ToIstanbul from "ast-v8-to-istanbul";
import { parseAstAsync } from "vitest/node";
import {
  coverageHookUrl,
  hookPresentInNodeOptions,
  RAW_COVERAGE_ENV,
  stripCoverageHookFromNodeOptions,
} from "./hook-url.js";

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

const ROOTS_ENV = "TYPE_A_BIN_SUBPROCESS_COVERAGE_ROOTS";

const TS_EXTENSIONS = [".cts", ".mts", ".ts", ".tsx"];

// The raw-profile directory for this run, or undefined when
// propagation is off.
const rawCoverageDir = (env = process.env): string | undefined => {
  const dir = env[RAW_COVERAGE_ENV];
  return dir === undefined || dir === "" ? undefined : dir;
};

// Environment that makes a child write raw profiles and load the
// observer hook. Children inherit the runner's environment by default,
// so applying this to the runner reaches every descendant; spreading
// it into an explicit `env` covers the rest. The hook is appended so
// it registers after any `--import` loader already present:
// registerHooks chains are LIFO, and only a hook registered after a
// transforming loader sees its output — the code NODE_V8_COVERAGE
// offsets address. A loader on the child's own argv still registers
// after everything here, so such launchers must order the hook
// themselves (see stripCoverageHookFromNodeOptions). Idempotent:
// NODE_OPTIONS that already loads the hook passes through untouched.
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
      : [options, `--import ${hook}`].filter((part) => part !== "").join(" "),
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

// Transforms recorded by coverage-hook.mjs, grouped by the pid that
// recorded them (the file name carries it) plus a deterministic
// per-URL fallback. Raw profiles are named coverage-<pid>-… and their
// offsets address the code that same process compiled, so a profile
// must be converted against its own pid's records: one child can load
// a module through tsx (transpiled code plus its source map) while
// another runs it through Node's native type stripping (original
// code, types erased in place), and either record misaligns the
// other's snapshot — at branch-slot granularity first, whole
// statements only later. Pids that recorded no transform (a file lost
// mid-write, a stale profile a failed run left behind) share the
// fallback, whose pick must never depend on directory order.
type TransformRecords = {
  byPid: Map<string, Map<string, TransformRecord>>;
  fallback: Map<string, TransformRecord>;
};

// First record per URL wins, except that a record carrying a source
// map displaces a map-less incumbent: when two pipelines (or two
// observer copies) recorded one URL, the map-bearing record is the
// transpiled output whose offsets the profiler addressed. File names
// are sorted before reading, so "first" is a function of the
// directory's contents alone, never of readdir order.
const keepPreferred = (
  records: Map<string, TransformRecord>,
  candidate: TransformRecord,
): void => {
  const incumbent = records.get(candidate.url);
  if (
    incumbent === undefined ||
    (incumbent.map === undefined && candidate.map !== undefined)
  )
    records.set(candidate.url, candidate);
};

const readTransforms = (dir: string): TransformRecords => {
  const files = readdirSync(dir)
    .filter((name) => TRANSFORM_FILE.test(name))
    .sort();
  const byPid = new Map<string, Map<string, TransformRecord>>();
  const fallback = new Map<string, TransformRecord>();
  for (const name of files) {
    const lines = readTransformLines(join(dir, name));
    // A pid whose every line is torn recorded nothing; its profiles
    // fall back rather than pair with an empty map.
    if (lines.length === 0) continue;
    const pid = pidOf(name);
    let own = byPid.get(pid);
    if (own === undefined) {
      own = new Map<string, TransformRecord>();
      byPid.set(pid, own);
    }
    for (const record of lines) {
      keepPreferred(own, record);
      keepPreferred(fallback, record);
    }
  }
  return { byPid, fallback };
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

/** One raw profile, tagged with the pid that wrote it. */
type RawProfile = { pid: string; scripts: RawScriptCoverage[] };

// Per-URL function coverages grouped per profile file, each tagged
// with the pid that wrote it (the file name carries it) so the merge
// can pair the profile with that pid's transform records. Each child
// writes its own profile on exit, and each profile must be converted
// on its own — a single conversion over concatenated entries loses
// hits, because a reappearing function name overwrites whatever an
// earlier child's snapshot credited. Merging the per-child results
// through istanbul unions them, and istanbul only distinguishes hit
// (>0) from unhit (0), so the union never flips a covered statement
// back to uncovered.
const readRawProfiles = (dir: string): RawProfile[] =>
  readdirSync(dir)
    .filter((name) => PROFILE_FILE.test(name))
    .sort()
    .map((name) => ({
      pid: pidOf(name),
      scripts: readProfileScripts(join(dir, name)),
    }));

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
  const { byPid, fallback } = readTransforms(rawDir);
  if (fallback.size === 0) return 0;
  // Group the profiles by the transform records they must convert
  // against — their own pid's when that pid recorded any, the
  // deterministic fallback otherwise — so every snapshot is remapped
  // onto the code its own process compiled, never onto whatever shape
  // a different pipeline happened to record for the same URL.
  const profilesByRecords = new Map<
    Map<string, TransformRecord>,
    RawProfile[]
  >();
  for (const profile of readRawProfiles(rawDir)) {
    const records = byPid.get(profile.pid) ?? fallback;
    const group = profilesByRecords.get(records);
    if (group === undefined) profilesByRecords.set(records, [profile]);
    else group.push(profile);
  }
  // A pid's records and the fallback can hold the same record for a
  // URL; keying preparations by record parses identical shapes once.
  // Istanbul merges by statement location, not index, so separate
  // preparations of one URL coexist in the report.
  const preparedByRecord = new Map<
    TransformRecord,
    PreparedScript | undefined
  >();
  const merged = new Set<string>();
  for (const [records, profiles] of profilesByRecords)
    for (const [url, record] of records) {
      if (!preparedByRecord.has(record)) {
        const prepared = await prepareScript(url, record, isIncluded);
        preparedByRecord.set(record, prepared);
      }
      const prepared = preparedByRecord.get(record);
      if (prepared === undefined) continue;
      let contributed = false;
      for (const profile of profiles)
        for (const script of profile.scripts) {
          if (script.url !== url) continue;
          const data = await convertSnapshot(url, script.functions, prepared);
          if (data === undefined) continue;
          coverageMap.merge(data);
          contributed = true;
        }
      if (contributed) merged.add(url);
    }
  return merged.size;
};

export type { MergeableCoverageMap, RemapFilter };
export {
  coverageHookUrl,
  hookPresentInNodeOptions,
  mergeSubprocessCoverage,
  RAW_COVERAGE_ENV,
  ROOTS_ENV,
  rawCoverageDir,
  stripCoverageHookFromNodeOptions,
  subprocessCoverageEnv,
};
