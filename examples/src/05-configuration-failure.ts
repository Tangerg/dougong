import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  ConfigurationValidationError,
  createHost,
  definePlugin,
  describePlugin,
  optional,
  service,
} from "dougong";
import { exampleResult, expectFailure, type ExampleResult } from "./example.js";

interface Cache {
  readonly capacity: number;
}

interface Audit {
  readonly entries: number;
}

interface CacheOptions {
  readonly capacity?: number;
}

interface CacheConfiguration {
  readonly capacity: number;
}

const CACHE = service<Cache>("examples/configuration/cache");
const AUDIT = service<Audit>("examples/configuration/audit");

const cacheConfigurationSchema: StandardSchemaV1<CacheOptions, CacheConfiguration> = {
  "~standard": {
    version: 1,
    vendor: "dougong-examples",
    validate(value) {
      if (value !== undefined && (typeof value !== "object" || value === null)) {
        return { issues: [{ message: "cache configuration must be an object" }] };
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

export async function configurationAndFailure(): Promise<ExampleResult> {
  let cacheStarts = 0;
  let auditStarts = 0;
  let auditReleases = 0;

  const cachePlugin = definePlugin({
    name: "examples.configuration.cache",
    configuration: cacheConfigurationSchema,
    provides: { cache: CACHE },
    setup: (_context, configuration) => {
      cacheStarts++;
      return { cache: { capacity: configuration.capacity } };
    },
  });

  const descriptor = describePlugin(cachePlugin);
  const serializedDescription = JSON.stringify(descriptor);
  const startsAfterDescription = cacheStarts;

  const auditPlugin = definePlugin({
    name: "examples.configuration.audit",
    requires: { cache: CACHE },
    provides: { audit: AUDIT },
    setup(context) {
      auditStarts++;
      context.lifetime.defer(() => auditReleases++);
      return { audit: { entries: context.dependencies.cache.capacity } };
    },
  });

  const socketFailure = new Error("exporter could not open its socket");
  const exporterPlugin = definePlugin({
    name: "examples.configuration.exporter",
    requires: { audit: AUDIT },
    setup() {
      throw socketFailure;
    },
  });

  const host = createHost({ name: "configuration-failure" });
  const initial = host.change();
  const cacheInstallation = initial.install(cachePlugin, {
    id: "cache",
    configuration: { capacity: 128 },
  });
  await host.apply(await host.plan(initial));
  await host.start();
  const { value: running } = await host.use(CACHE, (cache) => cache.capacity);

  let issues: ReadonlyArray<string>;
  try {
    const invalid = host.change();
    invalid.update(cacheInstallation, { configuration: { capacity: 0 } });
    await host.plan(invalid);
    throw new Error("The invalid configuration was accepted");
  } catch (error) {
    if (!(error instanceof ConfigurationValidationError)) throw error;
    issues = error.issues.map((issue) => issue.message);
  }
  const { value: afterInvalidConfiguration } = await host.use(CACHE, (cache) => cache.capacity);

  const change = host.change();
  change.install(auditPlugin, { id: "audit" });
  change.install(exporterPlugin, { id: "exporter" });
  const plan = await host.plan(change);
  const failure = await expectFailure("TRANSITION_FAILED", () => host.apply(plan));
  if (failure.details.outcome !== "restored" || failure.cause !== socketFailure) throw failure;

  const { value: afterRollback } = await host.use(CACHE, (cache) => cache.capacity);
  const status = host.status;
  const { value: auditPublished } = await host.use(optional(AUDIT), (audit) => audit !== undefined);
  await host.stop();

  return exampleResult({
    id: "05",
    title: "A rejected declaration and a failed setup",
    facts: [
      `The declaration produced ${serializedDescription.length} bytes of JSON for docs and agents, configuration schema '${descriptor.configuration.status}', with ${startsAfterDescription} setup calls.`,
      `The cache started with a validated capacity of ${running}.`,
      `The invalid update was rejected with ${issues.join("; ")}, before any Instance stopped.`,
      `The running cache never moved: capacity ${afterInvalidConfiguration} → ${afterRollback}.`,
      `Core reported ${failure.code} with outcome '${failure.details.outcome}'. The audit Instance started ${auditStarts} time and was released ${auditReleases} time.`,
      `Rollback is undone work, not skipped work — AUDIT published = ${auditPublished}, Host status '${status}'.`,
    ],
  });
}
