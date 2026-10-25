interface MockBehaviourScript {
    /** Binary name, as the pattern matches it against the command line. */
    binName: string;
    stdout: string[];
    stderr: string[];
    exitCode: number;
    delayMs: number;
    lineDelayMs: number;
    recordStdin: boolean;
    /** Regex source; only matching commands run the behaviour. */
    pattern?: string;
    /** Directory that receives one JSON record per invocation. */
    recordDir?: string;
    /** Life of the spawned descendant; absent means spawn none. */
    spawnChildMs?: number;
    /** How long trapped signals keep the mock alive; absent traps none. */
    trapSignalsMs?: number;
}
/** Runs one invocation of a mock built from a scripted behaviour. */
declare const runMockBehaviour: (script: MockBehaviourScript) => Promise<void>;
export { type MockBehaviourScript, runMockBehaviour };
