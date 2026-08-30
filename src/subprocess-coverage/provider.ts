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

// Propagation reaches only children that inherit NODE_V8_COVERAGE and
// the observer hook from the runner's environment, so wire both into
// process.env the moment vitest loads this module — before the pool
// workers, and every process they spawn, fork. Idempotent, and a no-op
// unless the runner opted in by naming a raw-profile directory.
for (const [name, value] of Object.entries(subprocessCoverageEnv()))
  process.env[name] = value;

// The stock v8 provider plus a merge of the raw NODE_V8_COVERAGE
// profiles written by the Node children the suite spawns — see
// merge.ts for the pipeline. The worker-side hooks are re-exported
// from the stock module unchanged, so a run without the opt-in env
// var reports exactly what the stock provider would.
class SubprocessV8CoverageProvider extends V8CoverageProvider {
  // Runs before every run (and between watch reruns); stale raw
  // profiles from a previous run must not inflate this one.
  override async clean(doClean = true) {
    await super.clean(doClean);
    if (doClean) await this.removeRawDir();
  }

  override async generateCoverage(context: ReportContext) {
    const coverageMap = await super.generateCoverage(context);
    try {
      await this.mergeRawProfiles(coverageMap);
    } catch (err) {
      this.ctx.logger.error(`subprocess coverage merge failed: ${String(err)}`);
    }
    return coverageMap;
  }

  // Skipped when threshold checks throw, so a failing run keeps its
  // raw data for debugging; TYPE_A_BIN_KEEP_RAW_COVERAGE=1 keeps it on
  // green runs too.
  override async cleanAfterRun(): Promise<void> {
    await super.cleanAfterRun();
    if (process.env.TYPE_A_BIN_KEEP_RAW_COVERAGE !== "1")
      await this.removeRawDir();
  }

  private async removeRawDir(): Promise<void> {
    const rawDir = rawCoverageDir();
    if (rawDir !== undefined)
      await rm(rawDir, { recursive: true, force: true });
  }

  private async mergeRawProfiles(
    coverageMap: MergeableCoverageMap,
  ): Promise<void> {
    const rawDir = rawCoverageDir();
    if (rawDir === undefined) return;
    const merged = await mergeSubprocessCoverage(coverageMap, rawDir, (path) =>
      this.isIncluded(path),
    );
    if (merged > 0)
      this.ctx.logger.log(
        ` % merged subprocess coverage for ${merged} files into the report`,
      );
  }
}

const providerModule: CoverageProviderModule = {
  ...baseCoverageV8,
  getProvider: () => new SubprocessV8CoverageProvider(),
};

export { providerModule as default };
