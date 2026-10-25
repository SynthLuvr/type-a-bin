import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { threadId } from "node:worker_threads";
// Fallback Windows entry point, loaded through `NODE_OPTIONS --import`
// into every Node process spawned while mocks are active. A legacy shim
// is a hard link of node.exe renamed <bin>.exe, so the command line
// ("status", "--porcelain", ...) is not a real module; the dispatch in
// mock-bin-runtime swaps the shim's main entry for the mock script
// named in TYPE_A_BIN_MOCKS — argv, stdin, stdout, stderr, and exit
// codes all pass through unchanged. The default Windows mechanism is
// the argv-preserving trampoline launcher (see mock-bin-windows); this
// preload remains for the escape hatch that forces the old hardlinks
// while the launcher rolls out.
//
// The dispatch lives in mock-bin-runtime — its sibling module — and is
// loaded here dynamically by absolute URL so the same code runs from
// the compiled .js in the published package and the .ts source under
// node's native type stripping (spawned processes cannot rely on the
// .js → .ts specifier rewriting a bundler or test runner provides).
// Only a shim's own main thread may intercept: loaders such as tsx
// spawn workers whose entry-point load must pass through untouched,
// and processes without the registry are not mocks at all.
const MOCKS_VAR = "TYPE_A_BIN_MOCKS";
const ownPath = fileURLToPath(import.meta.url);
const runtimeUrl = pathToFileURL(path.join(path.dirname(ownPath), `mock-bin-runtime${path.extname(ownPath)}`)).href;
if (process.env[MOCKS_VAR] !== undefined && threadId === 0)
    await (await import(runtimeUrl)).interceptShim();
