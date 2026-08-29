import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Shared loader resolution for script-file mocks. A script run through
// `node --import tsx` only resolves the bare `tsx` specifier while the
// mocked process's working directory sits inside the package that
// installed tsx — a mock spawned from a temp directory loses it. The
// script-file convention therefore resolves the loader to an absolute
// file URL up front: the POSIX mock embeds it in its exec line and the
// Windows shim puts it in NODE_OPTIONS, so the mock works from any
// working directory.
//
// Two resolution bases, in order:
//
// 1. the script file itself — picks the tsx installed in the package
//    the mock script lives in (workspace-local installs included);
// 2. this module — picks the tsx installed alongside type-a-bin in the
//    consuming project's tree (scripts written to a temp directory).
//
// When neither base resolves, null comes back and node's native type
// stripping parses the script instead (see loadTsxCommonJs in
// mock-bin-preload for the same fallback inside the Windows shim).

const TS_EXTENSIONS = [".cts", ".mts", ".ts", ".tsx"];

const resolutionBases = (scriptFile: string | undefined): string[] => [
  ...(scriptFile === undefined ? [] : [path.resolve(scriptFile)]),
  import.meta.url,
];

const isTypeScriptFile = (file: string): boolean =>
  TS_EXTENSIONS.includes(path.extname(file).toLowerCase());

/**
 * Absolute file URL of the tsx loader, resolved from the script's
 * package first and type-a-bin's own tree second, or null when tsx is
 * not installed.
 */
const resolveTsxImportUrl = (scriptFile?: string): string | null => {
  for (const base of resolutionBases(scriptFile))
    try {
      return pathToFileURL(createRequire(base).resolve("tsx")).href;
    } catch {
      // tsx is not resolvable from this base — try the next one.
    }

  return null;
};

export { isTypeScriptFile, resolveTsxImportUrl };
