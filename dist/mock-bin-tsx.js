import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
// A mock run through `node --import tsx` only resolves the bare `tsx`
// specifier while its working directory sits inside the package that
// installed tsx; a mock spawned from a temp directory loses it. The
// loader is therefore resolved to an absolute file URL up front — the
// POSIX mock embeds it in its exec line, the Windows shim carries it in
// NODE_OPTIONS — from the script's own package first (workspace-local
// installs included) and type-a-bin's own tree second (scripts written
// to a temp directory). When neither resolves, null comes back and
// node's native type stripping parses the script instead.
const TS_EXTENSIONS = [".cts", ".mts", ".ts", ".tsx"];
const isTypeScriptFile = (file) => TS_EXTENSIONS.includes(path.extname(file).toLowerCase());
/** Absolute file URL of the tsx loader, or null when tsx is not installed. */
const resolveTsxImportUrl = (scriptFile) => {
    const bases = [
        ...(scriptFile === undefined ? [] : [path.resolve(scriptFile)]),
        import.meta.url,
    ];
    for (const base of bases)
        try {
            return pathToFileURL(createRequire(base).resolve("tsx")).href;
        }
        catch {
            // tsx is not resolvable from this base — try the next one.
        }
    return null;
};
export { isTypeScriptFile, resolveTsxImportUrl };
