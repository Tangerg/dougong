import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ConfigValidationError, createHost, definePlugin, service } from "dougong";
import { exampleResult, failureMessage, type ExampleResult } from "./example";

interface Cache {
  readonly capacity: number;
}

interface Audit {
  readonly entries: number;
}

/** What a caller may pass. */
interface CacheOptions {
  readonly capacity?: number;
}

/** What `setup` receives after validation: defaults applied, invariants held. */
interface CacheConfig {
  readonly capacity: number;
}

const CACHE = service<Cache>("examples/config/cache");
const AUDIT = service<Audit>("examples/config/audit");

/**
 * Core ships no validator. It speaks Standard Schema, so zod, valibot or
 * arktype drop in unchanged — and so does this hand-written one.
 */
const cacheConfig: StandardSchemaV1<CacheOptions, CacheConfig> = {
  "~standard": {
    version: 1,
    vendor: "dougong-examples",
    validate(value) {
      if (value !== undefined && (typeof value !== "object" || value === null)) {
        return { issues: [{ message: "cache config must be an object" }] };
      }
      const capacity = value && "capacity" in value ? value.capacity : 64;
      if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 1) {
        return {
          issues: [{ message: "capacity must be a positive integer", path: ["capacity"] }],
        };
      }
      return { value: { capacity } };
    },
  },
};

/** A rejected declaration and a failed setup both leave the running graph untouched. */
export async function configAndFailure(): Promise<ExampleResult> {
  let auditStarts = 0;
  let auditReleases = 0;

  const cachePlugin = definePlugin({
    name: "examples.config.cache",
    config: cacheConfig,
    provides: { cache: CACHE },
    // `config` is the validated output type, so the default is already applied.
    setup: (_ctx, config) => ({ cache: { capacity: config.capacity } }),
  });

  const auditPlugin = definePlugin({
    name: "examples.config.audit",
    requires: { cache: CACHE },
    provides: { audit: AUDIT },
    setup(ctx) {
      auditStarts++;
      ctx.cleanup(() => auditReleases++);
      return { audit: { entries: ctx.cache.capacity } };
    },
  });

  // Depends on the audit service, so the layer above must start first — which
  // makes "started, then rolled back" observable rather than racy.
  const exporterPlugin = definePlugin({
    name: "examples.config.exporter",
    requires: { audit: AUDIT },
    setup() {
      throw new Error("exporter could not open its socket");
    },
  });

  const host = createHost({ name: "config-failure" });
  const cacheInstallation = host.install(cachePlugin, { capacity: 128 });
  await host.start();
  const running = host.get(CACHE).capacity;

  // 1. An invalid declaration. Validation runs before anything is stopped.
  let issues: ReadonlyArray<string> = [];
  try {
    await cacheInstallation.update({ config: { capacity: 0 } });
  } catch (error) {
    if (!(error instanceof ConfigValidationError)) throw error;
    issues = error.issues.map((issue) => issue.message);
  }
  const afterInvalidConfig = host.get(CACHE).capacity;

  // 2. A valid declaration whose setup fails, inside one ChangeSet.
  const change = host.change();
  change.install(auditPlugin);
  change.install(exporterPlugin);
  let rejection = "";
  try {
    await change.commit();
  } catch (error) {
    rejection = failureMessage(error);
  }

  const afterRollback = host.get(CACHE).capacity;
  const status = host.status;
  let auditPublished = true;
  try {
    host.get(AUDIT);
  } catch {
    auditPublished = false;
  }
  await host.stop();

  return exampleResult({
    id: "05",
    stage: "composition",
    title: "A rejected declaration and a failed setup",
    introduces: ["config-schema", "config-validation", "change-set", "setup-failure", "rollback"],
    facts: [
      `The schema applied its default and the caller's override: capacity ${running}.`,
      `The invalid update was rejected with ${issues.join("; ")}, before any Instance stopped.`,
      `The running cache never moved: capacity ${afterInvalidConfig} → ${afterRollback}.`,
      `The failing commit rejected with '${rejection}'; the audit Instance started ${auditStarts} time and was released ${auditReleases} time.`,
      `Rollback is undone work, not skipped work — AUDIT published = ${auditPublished}, Host status '${status}'.`,
    ],
  });
}
