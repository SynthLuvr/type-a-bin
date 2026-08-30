import { rm } from "node:fs/promises";
import baseCoverageV8 from "@vitest/coverage-v8";
import { V8CoverageProvider } from "@vitest/coverage-v8/dist/provider.js";
import type { CoverageProviderModule, ReportContext } from "vitest/node";
import {
  type MergeableCoverageMap,
  mergeSubprocessCoverage,
  rawCoverageDir,
  subprocessCoverageEnv,
} from "./merge.js";

// The propagation only reaches children that inherit NODE_V8_COVERAGE
// and the observer hook from the runner's environment, so the provider
// wires both into process.env the moment vitest loads it — before the
// pool workers, and every process they spawn, fork. Idempotent, and a
// no-op unless the runner opted in by naming a raw-profile directory.
for (const [name, value] of Object.entries(subprocessCoverageEnv()))
  process.env[name] = value;

// The stock v8 provider plus a merge of the raw NODE_V8_COVERAGE
// profiles written by the Node children the suite spawns — see
// merge.ts for the pipeline. Wired in via coverage.customProviderModule;
// the worker-side hooks (startCoverage/takeCoverage/stopCoverage) are
// re-exported from the stock module unchanged, so a run without the
// opt-in env var reports exactly what the stock provider would.
class SubprocessV8CoverageProvider extends V8CoverageProvider {
  // vitest calls clean() before every run (and between watch reruns);
  // stale raw profiles from a previous run must not inflate this one.
  override async clean(doClean = true) {
    await super.clean(doClean);
    const rawDir = rawCoverageDir();
    if (doClean && rawDir !== undefined)
      await rm(rawDir, { recursive: true, force: true });
  }

  override async generateCoverage(context: ReportContext) {
    const coverageMap = await super.generateCoverage(context);
    const rawDir = rawCoverageDir();
    if (rawDir !== undefined)
      try {
        await this.mergeRawProfiles(rawDir, coverageMap);
      } catch (err) {
        this.ctx.logger.error(
          `subprocess coverage merge failed: ${String(err)}`,
        );
      }

    return coverageMap;
  }

  private async mergeRawProfiles(
    rawDir: string,
    coverageMap: MergeableCoverageMap,
  ): Promise<void> {
    const merged = await mergeSubprocessCoverage(coverageMap, rawDir, (path) =>
      this.isIncluded(path),
    );
    if (merged > 0)
      this.ctx.logger.log(
        ` % merged subprocess coverage for ${merged} files into the report`,
      );
  }

  // The raw profile directory has served its purpose once the report
  // (and threshold checks) completed. cleanAfterRun is skipped when
  // thresholds throw, so a failing run keeps its raw data for
  // debugging; TYPE_A_BIN_KEEP_RAW_COVERAGE=1 keeps it on green runs
  // too (investigating run-to-run coverage variance).
  override async cleanAfterRun(): Promise<void> {
    await super.cleanAfterRun();
    const rawDir = rawCoverageDir();
    if (
      process.env.TYPE_A_BIN_KEEP_RAW_COVERAGE !== "1" &&
      rawDir !== undefined
    )
      await rm(rawDir, { recursive: true, force: true });
  }
}

const providerModule: CoverageProviderModule = {
  ...baseCoverageV8,
  getProvider: () => new SubprocessV8CoverageProvider(),
};

export { providerModule as default };
