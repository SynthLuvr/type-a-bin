interface MockTarget {
    /** "node" redirects the main entry in-process; "spawn" runs a script. */
    kind: "node" | "spawn";
    /** Absolute path of the mock script to run. */
    entry: string;
    /** Interpreter name for "spawn" targets (e.g. "bash", "python"). */
    interpreter?: string;
    /** Regex source; only matching commands run the mock. */
    pattern?: string;
    /** PATH snapshot from before this mock was installed. */
    originalPath?: string;
    /**
     * Absolute file URL of the tsx loader for TypeScript entries. The
     * trampoline bootstrap imports it before the entry so `.ts` mocks
     * load through tsx without a NODE_OPTIONS preload.
     */
    tsxImportUrl?: string;
}
interface RunOriginalTarget {
    binName: string;
    originalPath: string;
}
interface MocksEnv {
    targets?: Record<string, MockTarget>;
    runOriginal?: RunOriginalTarget;
}
/**
 * Runs a node-kind mock entry as the process's main module — the
 * trampoline bootstrap's dispatch and, exported for it, the run-cli
 * launcher facade. Unlike a shim, the process already has a real
 * main module (the bootstrap itself), so there is no REPL to avoid and
 * no entry redirection needed. CommonJS entries load through
 * `Module._load` with `isMain` set, so `require.main` matches a script
 * started as `node entry.cjs`; other entries load as ESM, with tsx
 * registered first when the target carries a loader URL.
 */
declare const runNodeEntryAsMain: (entry: string, cliArgs: string[], tsxImportUrl: string | undefined) => Promise<void>;
/**
 * Trampoline entry point. The native launcher starts Node as
 * `[node, mock-bin-trampoline.cjs, <mock>.exe, ...originalArgs]`, so the
 * invoked binary is the path in argv[2] and every argument after it is
 * the caller's original argv — Node's option parser never sees it.
 */
declare const runTrampoline: () => Promise<void>;
/**
 * Shim entry point for the NODE_OPTIONS preload: the process itself is
 * a hard link of node.exe named after the mocked binary, so the main
 * entry is redirected in-process once the registry recognizes the
 * invocation. Kept as the fallback behind the trampoline rollout.
 */
declare const interceptShim: () => Promise<void>;
export { interceptShim, type MocksEnv, type MockTarget, type RunOriginalTarget, runNodeEntryAsMain, runTrampoline, };
