import type { Awaitable } from "dougong";
import { captureDataArray, resolveValue } from "dougong/advanced";
import type { ArtifactDescriptor } from "../artifacts/artifact.js";
import { isTrimmedText } from "../artifacts/manifest.js";
import { PlatformError, permissionDeniedCode } from "../errors.js";

export interface AdmissionRequest {
  readonly artifact: ArtifactDescriptor;
  readonly operation: "load" | "activate";
}

// Admission authorizes an attempt; it cannot constrain code already executing in the same realm.
export interface Authorizer {
  readonly authorize: (request: AdmissionRequest, signal: AbortSignal) => Awaitable<void>;
}

export class PermissionDeniedError extends PlatformError {
  override readonly name: string = "PermissionDeniedError";
  readonly manifestName: string;
  readonly denied: ReadonlyArray<string>;

  constructor(manifestName: string, denied: ReadonlyArray<string>) {
    if (!isTrimmedText(manifestName)) {
      throw new TypeError("PermissionDeniedError manifestName must be a non-empty trimmed string");
    }
    const immutableDenied = Object.freeze(
      captureDataArray(denied, "PermissionDeniedError denied permissions").map(
        (permission, index) => {
          if (!isTrimmedText(permission)) {
            throw new TypeError(
              `PermissionDeniedError denied permission at index ${index} must be a non-empty trimmed string`,
            );
          }
          return permission;
        },
      ),
    );
    super(
      permissionDeniedCode,
      `Manifest '${manifestName}' was denied permissions: ${immutableDenied.join(", ")}`,
      { details: { outcome: "rejected", phase: "admission" } },
    );
    this.manifestName = manifestName;
    this.denied = immutableDenied;
  }
}

export function captureAuthorizer(policy: Authorizer): Authorizer {
  const authorize = policy?.authorize;
  if (typeof authorize !== "function")
    throw new TypeError("Platform authorizer must implement authorize()");
  return Object.freeze<Authorizer>({
    authorize: (request, signal) => admitted(Reflect.apply(authorize, policy, [request, signal])),
  });
}

async function admitted(result: unknown) {
  if ((await resolveValue(result)).value !== undefined)
    throw new TypeError(
      "Authorizer must return no value on approval and throw or reject on denial",
    );
}

export class PermissionSet implements Authorizer {
  readonly #allowed: ReadonlySet<string>;

  constructor(allowed: Iterable<string> & object = []) {
    if (!allowed || (typeof allowed !== "object" && typeof allowed !== "function")) {
      throw new TypeError("PermissionSet permissions must be an iterable object");
    }
    const permissions = new Set<string>();
    for (const permission of allowed) {
      if (!isTrimmedText(permission))
        throw new TypeError("PermissionSet entry must be a non-empty trimmed string");
      permissions.add(permission);
    }
    this.#allowed = permissions;
    Object.freeze(this);
  }

  readonly authorize = ({ artifact }: AdmissionRequest, signal: AbortSignal) => {
    AbortSignal.prototype.throwIfAborted.call(signal);
    const requested = captureDataArray(artifact.manifest.permissions, "Manifest permissions");
    const denied = requested.filter((permission) => !this.#allowed.has(permission));
    if (denied.length) throw new PermissionDeniedError(artifact.manifest.name, denied);
  };
}
