import { existsSync, readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import astV8ToIstanbul from "ast-v8-to-istanbul";
import { parseAstAsync } from "vitest/node";
import { coverageHookUrl, hookPresentInNodeOptions, RAW_COVERAGE_ENV, stripCoverageHookFromNodeOptions, } from "./hook-url.js";
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
const rawCoverageDir = (env = process.env) => {
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
const subprocessCoverageEnv = (env = process.env) => {
    const rawDir = rawCoverageDir(env);
    if (rawDir === undefined)
        return {};
    const hook = coverageHookUrl();
    const options = env.NODE_OPTIONS ?? "";
    return {
        NODE_V8_COVERAGE: rawDir,
        NODE_OPTIONS: options.includes(hook)
            ? options
            : [options, `--import ${hook}`].filter((part) => part !== "").join(" "),
    };
};
const PROFILE_FILE = /^coverage-.*\.json$/;
const TRANSFORM_FILE = /^transforms-.*\.jsonl$/;
// Profile and transform file names are <kind>-<pid>-<suffix>.
const pidOf = (fileName) => fileName.split("-")[1];
// One recorded module per line; a torn trailing line (crash mid-append)
// is skipped.
const readTransformLines = (file) => {
    const records = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line === "")
            continue;
        try {
            records.push(JSON.parse(line));
        }
        catch {
            continue;
        }
    }
    return records.filter((record) => typeof record.url === "string");
};
// First record per URL wins, except that a record carrying a source
// map displaces a map-less incumbent: when two pipelines (or two
// observer copies) recorded one URL, the map-bearing record is the
// transpiled output whose offsets the profiler addressed. Files are
// read in sorted order, so the winner is a function of the directory's
// contents alone, never of readdir order.
const keepPreferred = (records, candidate) => {
    const incumbent = records.get(candidate.url);
    if (incumbent === undefined ||
        (incumbent.map === undefined && candidate.map !== undefined))
        records.set(candidate.url, candidate);
};
const readTransforms = (dir) => {
    const files = readdirSync(dir)
        .filter((name) => TRANSFORM_FILE.test(name))
        .sort();
    const byPid = new Map();
    const fallback = new Map();
    for (const name of files) {
        const records = readTransformLines(join(dir, name));
        // A pid whose every line is torn recorded nothing; its profiles
        // fall back rather than pair with an empty map.
        if (records.length === 0)
            continue;
        const pid = pidOf(name);
        const own = byPid.get(pid) ?? new Map();
        byPid.set(pid, own);
        for (const record of records) {
            keepPreferred(own, record);
            keepPreferred(fallback, record);
        }
    }
    return { byPid, fallback };
};
// A raw profile Node writes on process exit; an unparseable file
// reads as empty.
const readProfileScripts = (file) => {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        return parsed.result ?? [];
    }
    catch {
        return [];
    }
};
// Per-URL function coverages grouped per profile file, each tagged
// with the pid that wrote it so the merge can pair the profile with
// that pid's transform records. Each child writes its own profile on
// exit, and each profile must be converted on its own — a single
// conversion over concatenated entries loses hits, because a
// reappearing function name overwrites whatever an earlier child's
// snapshot credited. Merging the per-child results through istanbul
// unions them, and istanbul only distinguishes hit (>0) from unhit
// (0), so the union never flips a covered statement back to
// uncovered.
const readRawProfiles = (dir) => readdirSync(dir)
    .filter((name) => PROFILE_FILE.test(name))
    .map((name) => ({
    pid: pidOf(name),
    scripts: readProfileScripts(join(dir, name)),
}));
const extensionOf = (url) => {
    const base = basename(fileURLToPath(url));
    const at = base.lastIndexOf(".");
    return at <= 0 ? "" : base.slice(at);
};
// Code the merge can parse and remap. A recorded source map (a loader
// like tsx transformed the module) travels with its transpiled code;
// a bare TypeScript source ran through Node's own type stripping,
// whose erasure preserves offsets, so stripping the types again yields
// parseable code whose positions still address the original file.
const toRemappableCode = (transform) => {
    if (transform.map !== undefined)
        return { code: transform.code, map: transform.map };
    if (!TS_EXTENSIONS.includes(extensionOf(transform.url)))
        return { code: transform.code, map: undefined };
    try {
        return { code: stripTypeScriptTypes(transform.code), map: undefined };
    }
    catch {
        return { code: transform.code, map: undefined };
    }
};
// Node compiles CommonJS modules inside a wrapper whose closing brace
// outlives the module's own text, so a range can end past the recorded
// code; clamping keeps every offset addressable.
const clampToEnd = (functions, length) => functions.map((fn) => ({
    ...fn,
    ranges: fn.ranges.map((range) => ({
        ...range,
        endOffset: Math.min(range.endOffset, length),
    })),
}));
// Everything needed to convert one script's raw offsets, prepared
// once per URL. Undefined when the script is out of scope or
// unparseable — a single bad module must not sink the whole report.
const prepareScript = async (url, transform, isIncluded) => {
    let path;
    try {
        path = fileURLToPath(decodeURIComponent(url));
    }
    catch {
        return undefined;
    }
    if (!existsSync(path) || !isIncluded(path))
        return undefined;
    try {
        const { code, map } = toRemappableCode(transform);
        return { code, map, ast: await parseAstAsync(code) };
    }
    catch {
        return undefined;
    }
};
// Converts one child's snapshot of a prepared script into istanbul
// data. Undefined when the conversion fails — one bad profile must
// not sink the whole merge.
const convertSnapshot = async (url, functions, prepared) => {
    try {
        return await astV8ToIstanbul({
            code: prepared.code,
            sourceMap: prepared.map,
            coverage: {
                url,
                functions: clampToEnd(functions, prepared.code.length),
            },
            ast: prepared.ast,
        });
    }
    catch {
        return undefined;
    }
};
// Converts each snapshot `profile` holds of `url` against `prepared`
// and merges the results into `coverageMap`; true when at least one
// snapshot contributed.
const mergeProfileSnapshots = async (coverageMap, url, prepared, profile) => {
    let contributed = false;
    for (const script of profile.scripts) {
        if (script.url !== url)
            continue;
        const data = await convertSnapshot(url, script.functions, prepared);
        if (data === undefined)
            continue;
        coverageMap.merge(data);
        contributed = true;
    }
    return contributed;
};
// Merges raw subprocess coverage into `coverageMap`. `isIncluded` is
// the provider's include/exclude filter, so the merge respects
// coverage.include exactly like in-process collection. URLs without a
// recorded transform (in-process worker coverage, helper scripts) are
// skipped: their offsets belong to a different transform pipeline, and
// vitest already handles the in-process ones itself. Returns the
// number of files that contributed coverage.
const mergeSubprocessCoverage = async (coverageMap, rawDir, isIncluded) => {
    if (!existsSync(rawDir))
        return 0;
    const { byPid, fallback } = readTransforms(rawDir);
    if (fallback.size === 0)
        return 0;
    // The same record recurs — across profiles sharing a records map,
    // and between a pid's map and the fallback — so parse each shape
    // once. Istanbul merges by statement location, not index, so
    // separate preparations of one URL coexist in the report.
    const preparedByRecord = new Map();
    const prepareOnce = async (url, record) => {
        // `has` rather than a `get` check: a failed preparation is stored
        // as undefined and must not be retried.
        if (preparedByRecord.has(record))
            return preparedByRecord.get(record);
        const prepared = await prepareScript(url, record, isIncluded);
        preparedByRecord.set(record, prepared);
        return prepared;
    };
    const merged = new Set();
    for (const profile of readRawProfiles(rawDir)) {
        // Each profile converts against the records its own pid wrote; a
        // pid that recorded none pairs with the shared fallback.
        const records = byPid.get(profile.pid) ?? fallback;
        for (const [url, record] of records) {
            const prepared = await prepareOnce(url, record);
            if (prepared === undefined)
                continue;
            if (await mergeProfileSnapshots(coverageMap, url, prepared, profile))
                merged.add(url);
        }
    }
    return merged.size;
};
export { coverageHookUrl, hookPresentInNodeOptions, mergeSubprocessCoverage, RAW_COVERAGE_ENV, ROOTS_ENV, rawCoverageDir, stripCoverageHookFromNodeOptions, subprocessCoverageEnv, };
