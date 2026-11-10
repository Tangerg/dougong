import { captureLogger, normalizePlainRecord, recordFields } from "dougong/advanced";
import type { Group, Host, Logger } from "dougong";
import { captureAuthorizer, PermissionSet, type Authorizer } from "../admission/permissions.js";
import { isConcreteVersion, isRegistrationIdPart } from "../artifacts/manifest.js";
import type { Loader } from "../loaders/loader.js";

export interface PlatformOptions<Reference> {
  readonly id: string;
  readonly host: Host;
  readonly group?: Group;
  readonly apiVersion: string;
  readonly loader: Loader<Reference>;
  readonly authorizer?: Authorizer;
  readonly logger?: Logger<unknown>;
}

export interface CapturedPlatformOptions<Reference> {
  readonly id: string;
  readonly apiVersion: string;
  readonly host: Host;
  readonly group: Group | undefined;
  readonly loader: Loader<Reference>;
  readonly authorizer: Authorizer;
  readonly logger: Logger<unknown>;
}

const optionFields = recordFields<PlatformOptions<unknown>>()(
  "id",
  "host",
  "group",
  "apiVersion",
  "loader",
  "authorizer",
  "logger",
);

// Captured protocol methods keep their original receivers without retaining the input object.
export function capturePlatformOptions<Reference>(
  options: PlatformOptions<Reference>,
): CapturedPlatformOptions<Reference> {
  const declaration = normalizePlainRecord(options, "Platform options", { fields: optionFields });
  const { id, host, group, apiVersion, loader, authorizer, logger } = declaration;
  if (!isRegistrationIdPart(id))
    throw new TypeError("Platform id must be a non-empty trimmed Unicode identifier");
  if (typeof apiVersion !== "string" || !isConcreteVersion(apiVersion))
    throw new TypeError("Platform apiVersion must be a semantic version");
  if (
    !host ||
    typeof host.change !== "function" ||
    typeof host.plan !== "function" ||
    typeof host.apply !== "function" ||
    typeof host.installation !== "function" ||
    !host.diagnostics
  ) {
    throw new TypeError("Platform host must implement planning, execution and inspection");
  }
  if (group !== undefined && host.group(group.id) !== group)
    throw new TypeError("Platform Group must be committed in its Host");
  const load = loader?.load;
  if (typeof load !== "function") throw new TypeError("Platform loader must implement load()");
  return Object.freeze({
    id,
    apiVersion,
    host,
    group,
    loader: Object.freeze({
      load: (reference: Reference, signal: AbortSignal) =>
        Reflect.apply(load, loader, [reference, signal]),
    }),
    authorizer: captureAuthorizer(authorizer === undefined ? new PermissionSet() : authorizer),
    logger: captureLogger(logger === undefined ? console : logger),
  });
}
