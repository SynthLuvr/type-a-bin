import { copyFileSync, linkSync, rmSync } from "node:fs";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MockBinScriptFile } from "./mock-bin.js";
import type { MocksEnv, MockTarget } from "./mock-bin-preload.js";

// Windows twin of the POSIX mockBin: PATH interception needs a real
// executable there (node refuses to spawn .cmd/.bat shims without a
// shell, and an extensionless #! script cannot execute at all). Each
// mock is a hard link of node.exe named <bin>.exe, and a preload
// (mock-bin-preload) registered through NODE_OPTIONS turns a spawn of
// that exe into the mock script — argv, stdin, stdout, stderr, and exit
// codes all pass through. The registry the preload reads (and its env
// var name) must stay in sync with mock-bin-preload.
const MOCKS_VAR = "TYPE_A_BIN_MOCKS";
const HELPER_NAME = "mock-a-bin-run-original";

// The preload ships next to this module: mock-bin-preload.js in the
// published dist build, mock-bin-preload.ts when running from source
// (node's native type stripping loads the .ts form in child processes).
const ownPath = fileURLToPath(import.meta.url);
const preloadPath = path.join(
  path.dirname(ownPath),
  `mock-bin-preload${path.extname(ownPath)}`,
);

const readMocks = (): MocksEnv => {
  try {
    return JSON.parse(process.env[MOCKS_VAR] ?? "{}") as MocksEnv;
  } catch {
    return {};
  }
};

const restoreEnv = (name: string, previous: string | undefined): void => {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
};

/** Hard links node.exe as `destination`, copying across volume boundaries. */
const linkNodeExecutable = (destination: string): void => {
  try {
    linkSync(process.execPath, destination);
  } catch {
    // Different volume than the node install: fall back to a real copy.
    copyFileSync(process.execPath, destination);
  }
};

/**
 * Splits an interpreter string into words, accepting both a bare name
 * ("bash"), a full shebang ("#!/usr/bin/env bash"), or an absolute
 * shebang path ("#!/bin/bash").
 */
const toInterpreterWords = (shebang: string): string[] =>
  shebang
    .replace(/^#!\s*/, "")
    .replace(/^\/(?:usr\/)?bin\/env\s+/, "")
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");

const basenameWithoutExecutableExtension = (word: string): string =>
  path.basename(word).replace(/\.(?:bat|cmd|com|exe)$/iu, "");

const isNodeInterpreter = (words: string[]): boolean =>
  basenameWithoutExecutableExtension(words[0] ?? "").toLowerCase() === "node";

const interpreterExecutableName = (word: string | undefined): string =>
  word === undefined ? "bash" : basenameWithoutExecutableExtension(word);

const usesTsx = (words: string[]): boolean =>
  words.some((word) => word === "tsx" || word.startsWith("tsx/"));

const resolveTsxImportUrl = (): string => {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  } catch {
    throw new Error(
      "mockBin: the interpreter requires the tsx package, but tsx is not " +
        "installed. Add tsx to your devDependencies to mock through node " +
        "--import tsx on Windows.",
    );
  }
};

const toShebangLine = (interpreter: string): string =>
  interpreter.startsWith("#!") ? interpreter : `#!/usr/bin/env ${interpreter}`;

/**
 * Builds the CommonJS mock for the output shorthand. bash `echo` expands
 * positional parameters, so the Node twin expands `$1`..`$9`, `$*`, and
 * `$@` from the command line to keep the shorthand's behaviour aligned.
 */
const echoScript = (output: string): string => `
const args = process.argv.slice(2);
const expand = (text) =>
  text
    .replace(/\\$[@*]/g, args.join(" "))
    .replace(/\\$(\\d)/g, (_, digit) => args[Number(digit) - 1] ?? "");
console.log(expand(${JSON.stringify(output)}));
`;

const assertScriptFile = async (file: string): Promise<void> => {
  const stats = await stat(file).catch(() => null);
  if (!stats?.isFile())
    throw new Error(`mockBin: script file not found: ${file}`);
};

/**
 * Windows implementation of `mockBin`; see mock-bin.ts for the public
 * overloads. Installs `<binName>.exe` (a hard link of node.exe) and the
 * `mock-a-bin-run-original.exe` helper into a temp directory prepended
 * to PATH, registers the mock in the preload's registry, and extends
 * NODE_OPTIONS with the preload import.
 */
const mockBinWindows = async (
  binName: string,
  pattern: string | undefined,
  shebangOrOutput: string,
  codeOrScript: string | MockBinScriptFile | undefined,
): Promise<() => void> => {
  if (typeof codeOrScript === "object")
    await assertScriptFile(codeOrScript.file);

  const originalPath = process.env.PATH ?? "";
  const previousNodeOptions = process.env.NODE_OPTIONS;
  const previousMocks = process.env[MOCKS_VAR];

  // A binName already carrying .exe stays a valid executable name while
  // the registry key matches the shim's argv[0] basename.
  const binBase = binName.replace(/\.exe$/iu, "");
  const tempDir = await mkdtemp(path.join(tmpdir(), "mock-bin-"));
  linkNodeExecutable(path.join(tempDir, `${binBase}.exe`));
  linkNodeExecutable(path.join(tempDir, `${HELPER_NAME}.exe`));

  const words =
    codeOrScript === undefined ? ["node"] : toInterpreterWords(shebangOrOutput);
  const isNodeMock = codeOrScript === undefined || isNodeInterpreter(words);

  const interpreter = isNodeMock
    ? undefined
    : interpreterExecutableName(words[0]);
  let entry: string;
  if (typeof codeOrScript === "object") {
    // Script files keep their real extension, so extension-aware loaders
    // (e.g. node --import tsx) parse them.
    entry = path.resolve(codeOrScript.file);
  } else if (isNodeMock) {
    // Inline code runs as CommonJS, matching the extensionless scripts
    // the POSIX implementation writes (node parses those as CommonJS).
    entry = path.join(tempDir, `${binBase}-mock.cjs`);
    const code = codeOrScript ?? echoScript(shebangOrOutput);
    await writeFile(entry, `${code}\n`);
  } else {
    entry = path.join(tempDir, `${binBase}-mock.sh`);
    await writeFile(
      entry,
      `${toShebangLine(shebangOrOutput)}\n${codeOrScript}\n`,
    );
  }

  const target: MockTarget = {
    kind: isNodeMock ? "node" : "spawn",
    entry,
    ...(interpreter === undefined ? {} : { interpreter }),
    ...(pattern ? { pattern } : {}),
    originalPath,
  };

  const mocks = readMocks();
  process.env[MOCKS_VAR] = JSON.stringify({
    ...mocks,
    targets: { ...mocks.targets, [binBase]: target },
    runOriginal: { binName: binBase, originalPath },
  });

  // The preload rides along after the tsx loader when the interpreter
  // names it, so .ts entries resolve through tsx's ESM hooks in the
  // same resolve chain that redirects the shim entry.
  const imports = [
    ...(isNodeMock && usesTsx(words)
      ? [`--import ${resolveTsxImportUrl()}`]
      : []),
    `--import ${pathToFileURL(preloadPath).href}`,
  ];
  process.env.NODE_OPTIONS =
    previousNodeOptions === undefined || previousNodeOptions === ""
      ? imports.join(" ")
      : `${imports.join(" ")} ${previousNodeOptions}`;

  process.env.PATH = `${tempDir}${path.delimiter}${originalPath}`;

  return (): void => {
    if (originalPath === "") delete process.env.PATH;
    else process.env.PATH = originalPath;
    restoreEnv("NODE_OPTIONS", previousNodeOptions);
    restoreEnv(MOCKS_VAR, previousMocks);
    try {
      // Windows can transiently deny deleting files a just-exited
      // process still holds (the shim exes), so rmSync's retry options
      // cover that.
      rmSync(tempDir, {
        recursive: true,
        force: true,
        maxRetries: 40,
        retryDelay: 250,
      });
    } catch (error) {
      console.warn(
        `Warning: Failed to remove mock-bin temp directory ${tempDir}: ${String(error)}`,
      );
    }
  };
};

export { mockBinWindows };
