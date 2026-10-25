// Coverage observer loaded into every Node child that inherits the
// test runner's environment (via NODE_OPTIONS --import). Records, per
// in-scope module, the code the child actually executed plus its
// inline source map when the loader produced one; the vitest provider
// later uses those records to remap raw NODE_V8_COVERAGE offsets onto
// the original sources (see merge.ts).
//
// Must stay fully synchronous (registerHooks, no await): an async load
// hook breaks Node's synchronous load path (e.g. require(esm)) with
// ERR_INVALID_RETURN_PROPERTY_VALUE. All capture failures are
// swallowed — a broken observer must never take down a process under
// test.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOTS_ENV = "TYPE_A_BIN_SUBPROCESS_COVERAGE_ROOTS";
const SOURCE_MAP_MARKER = "//# sourceMappingURL=data:application/json;base64,";

const rawDir = process.env.NODE_V8_COVERAGE ?? "";
const enabled = rawDir !== "";
const cacheFile = enabled
  ? join(
      rawDir,
      `transforms-${process.pid}-${randomBytes(4).toString("hex")}.jsonl`,
    )
  : undefined;
const seen = new Set();

// Scope by both the literal path and its realpath: Node's ESM loader
// may report module URLs through either (Windows short-name aliases
// like RUNNER~1, macOS /tmp symlinks). A root that does not exist yet
// scopes by its literal form only.
const toPrefixes = (root) => {
  const absolute = resolve(root.replace(/[\\/]+$/, ""));
  const literal = `${pathToFileURL(absolute).href}/`;
  try {
    const real = `${pathToFileURL(realpathSync(absolute)).href}/`;
    return real === literal ? [literal] : [literal, real];
  } catch {
    return [literal];
  }
};

// Only modules under the roots can become report entries, so
// recording anything else is pure noise; node_modules is always
// skipped. The default root is the working directory the runner
// started from.
const roots = process.env[ROOTS_ENV] || process.cwd();
const scopePrefixes = enabled
  ? roots
      .split(delimiter)
      .filter((root) => root !== "")
      .flatMap(toPrefixes)
  : [];

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
    // JSON.stringify omits `map` when it is undefined.
    appendFileSync(
      cacheFile,
      `${JSON.stringify({ url, code, map })}\n`,
      "utf8",
    );
  } catch {
    // Best-effort capture; never break the process under test.
  }
};

const load = (url, context, nextLoad) => {
  const result = nextLoad(url, context);
  if (!seen.has(url) && inScope(url)) {
    const source = result.source;
    // CommonJS-flavoured formats hand the source back as a Buffer.
    if (typeof source === "string" || Buffer.isBuffer(source)) {
      seen.add(url);
      record(url, source.toString("utf8"));
    }
  }
  return result;
};

if (enabled) registerHooks({ load });
