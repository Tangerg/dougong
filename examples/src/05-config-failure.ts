import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ConfigValidationError, createHost, definePlugin, describePlugin, service } from "dougong";
import { exampleResult, failureMessage, type ExampleResult } from "./example.js";

interface Cache {
  readonly capacity: number;
}

interface Audit {
  readonly entries: number;
}

interface CacheOptions {
  readonly capacity?: number;
}

interface CacheConfig {
  readonly capacity: number;
}

const CACHE = service<Cache>("examples/config/cache");
const AUDIT = service<Audit>("examples/config/audit");

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

export async function configAndFailure(): Promise<ExampleResult> {
  let cacheStarts = 0;
  let auditStarts = 0;
  let auditReleases = 0;

  const cachePlugin = definePlugin({
    name: "examples.config.cache",
    config: cacheConfig,
    provides: { cache: CACHE },
    setup: (_ctx, config) => {
      cacheStarts++;
      return { cache: { capacity: config.capacity } };
    },
  });

  const descriptor = describePlugin(cachePlugin);
  const serializedDescription = JSON.stringify(descriptor);
  const startsAfterDescription = cacheStarts;

  const auditPlugin = definePlugin({
    name: "examples.config.audit",
    requires: { cache: CACHE },
    provides: { audit: AUDIT },
    setup(ctx) {
      auditStarts++;
      ctx.lifetime.defer(() => auditReleases++);
      return { audit: { entries: ctx.deps.cache.capacity } };
    },
  });

  const exporterPlugin = definePlugin({
    name: "examples.config.exporter",
    requires: { audit: AUDIT },
    setup() {
      throw new Error("exporter could not open its socket");
    },
  });

  const host = createHost({ name: "config-failure" });
  const initial = host.change();
  const cacheInstallation = initial.install(cachePlugin, {
    id: "cache",
    config: { capacity: 128 },
  });
  await host.apply(await host.plan(initial));
  await host.start();
  const running = await host.use(CACHE, (cache) => cache.capacity);

  let issues: ReadonlyArray<string> = [];
  try {
    const invalid = host.change();
    invalid.update(cacheInstallation, { config: { capacity: 0 } });
    await host.apply(await host.plan(invalid));
  } catch (error) {
    if (!(error instanceof ConfigValidationError)) throw error;
    issues = error.issues.map((issue) => issue.message);
  }
  const afterInvalidConfig = await host.use(CACHE, (cache) => cache.capacity);

  const change = host.change();
  change.install(auditPlugin, { id: "audit" });
  change.install(exporterPlugin, { id: "exporter" });
  let rejection = "";
  try {
    await host.apply(await host.plan(change));
  } catch (error) {
    rejection = failureMessage(error);
  }

  const afterRollback = await host.use(CACHE, (cache) => cache.capacity);
  const status = host.status;
  let auditPublished = true;
  try {
    await host.use(AUDIT, () => undefined);
  } catch {
    auditPublished = false;
  }
  await host.stop();

  return exampleResult({
    id: "05",
    stage: "composition",
    title: "A rejected declaration and a failed setup",
    introduces: [
      "config-schema",
      "config-validation",
      "plugin-description",
      "change-set",
      "setup-failure",
      "rollback",
    ],
    facts: [
      `The declaration produced ${serializedDescription.length} bytes of JSON for docs and agents, configuration schema '${descriptor.config.status}', with ${startsAfterDescription} setup calls.`,
      `The schema applied its default and the caller's override: capacity ${running}.`,
      `The invalid update was rejected with ${issues.join("; ")}, before any Instance stopped.`,
      `The running cache never moved: capacity ${afterInvalidConfig} → ${afterRollback}.`,
      `The failing commit rejected with '${rejection}'; the audit Instance started ${auditStarts} time and was released ${auditReleases} time.`,
      `Rollback is undone work, not skipped work — AUDIT published = ${auditPublished}, Host status '${status}'.`,
    ],
  });
}
