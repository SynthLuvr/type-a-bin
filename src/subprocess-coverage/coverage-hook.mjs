// Coverage observer for Node subprocesses, loaded via `--import`
// (usually through NODE_OPTIONS) into every child that inherits the
// test runner's environment. Raw NODE_V8_COVERAGE offsets point into
// the code Node actually executed: under tsx that is esbuild output
// carrying an inline source map, and under Node's own type stripping
// it is the recorded source itself — the transform only erases syntax
// in place, so offsets still address the original file. The hook
// therefore records { url, code, map } per in-scope module — the code
// the child really ran plus its inline source map when one exists —
// which the vitest provider later uses to remap offsets onto the
// original sources (see merge.ts).
//
// Must stay fully synchronous (registerHooks, no await): an async load
// hook breaks Node's synchronous load path (e.g. require(esm)) with
// ERR_INVALID_RETURN_PROPERTY_VALUE. Capture failures are swallowed —
// a broken observer must never take down a process under test.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOTS_ENV = "TYPE_A_BIN_SUBPROCESS_COVERAGE_ROOTS";
const SOURCE_MAP_MARKER = "//# sourceMappingURL=data:application/json;base64,";

const rawDir = process.env.NODE_V8_COVERAGE ?? "";
const cacheFile =
  rawDir === ""
    ? undefined
    : join(
        rawDir,
        `transforms-${process.pid}-${randomBytes(4).toString("hex")}.jsonl`,
      );
const seen = new Set();

// Only modules under these directories can become report entries, so
// recording anything else is pure noise. The default scopes the
// observer to the project the runner was started from; dependencies
// under node_modules are excluded even when they sit inside a root.
const toPrefix = (root) =>
  `${pathToFileURL(resolve(root.replace(/[\\/]+$/, ""))).href}/`;

const rootsEnv = process.env[ROOTS_ENV];
const scopePrefixes =
  cacheFile === undefined
    ? []
    : (rootsEnv === undefined || rootsEnv === "" ? process.cwd() : rootsEnv)
        .split(delimiter)
        .filter((root) => root !== "")
        .map(toPrefix);

const inScope = (url) =>
  typeof url === "string" &&
  !url.includes("/node_modules/") &&
  scopePrefixes.some((prefix) => url.startsWith(prefix));

const extractInlineMap = (code) => {
  const at = code.lastIndexOf(SOURCE_MAP_MARKER);
  if (at === -1) return undefined;
  try {
    return JSON.parse(
      Buffer.from(code.slice(at + SOURCE_MAP_MARKER.length), "base64").toString(
        "utf8",
      ),
    );
  } catch {
    return undefined;
  }
};

const record = (url, code) => {
  const map = extractInlineMap(code);
  try {
    mkdirSync(rawDir, { recursive: true });
    appendFileSync(
      cacheFile,
      `${JSON.stringify(map === undefined ? { url, code } : { url, code, map })}\n`,
      "utf8",
    );
  } catch {
    // Best-effort capture; never break the process under test.
  }
};

const load = (url, context, nextLoad) => {
  const result = nextLoad(url, context);
  if (cacheFile !== undefined && !seen.has(url) && inScope(url)) {
    const source = result.source;
    // CommonJS-flavoured formats hand the source back as a Buffer.
    if (typeof source === "string" || Buffer.isBuffer(source)) {
      seen.add(url);
      record(url, source.toString("utf8"));
    }
  }
  return result;
};

if (cacheFile !== undefined) registerHooks({ load });
