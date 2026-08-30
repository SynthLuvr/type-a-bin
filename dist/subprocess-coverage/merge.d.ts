import { coverageHookUrl, hookPresentInNodeOptions, RAW_COVERAGE_ENV, stripCoverageHookFromNodeOptions } from "./hook-url.js";
declare const ROOTS_ENV = "TYPE_A_BIN_SUBPROCESS_COVERAGE_ROOTS";
declare const rawCoverageDir: (env?: NodeJS.ProcessEnv) => string | undefined;
declare const subprocessCoverageEnv: (env?: NodeJS.ProcessEnv) => Record<string, string>;
/** Structural slice of istanbul's CoverageMap that the merge needs. */
type MergeableCoverageMap = {
    merge(data: unknown): void;
};
type RemapFilter = (path: string) => boolean;
declare const mergeSubprocessCoverage: (coverageMap: MergeableCoverageMap, rawDir: string, isIncluded: RemapFilter) => Promise<number>;
export type { MergeableCoverageMap, RemapFilter };
export { coverageHookUrl, hookPresentInNodeOptions, mergeSubprocessCoverage, RAW_COVERAGE_ENV, ROOTS_ENV, rawCoverageDir, stripCoverageHookFromNodeOptions, subprocessCoverageEnv, };
