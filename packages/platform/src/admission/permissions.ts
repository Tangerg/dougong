import type { Awaitable } from "dougong";
import type { ArtifactDescriptor } from "../artifacts/artifact.js";
import { PermissionDeniedError } from "../errors.js";

export interface AdmissionRequest {
  readonly artifact: ArtifactDescriptor;
  readonly operation: "load" | "activate";
}

// Admission authorizes an attempt; it cannot constrain code already executing in the same realm.
export interface Authorizer {
  readonly authorize: (request: AdmissionRequest, signal: AbortSignal) => Awaitable<void>;
}

export class PermissionSet implements Authorizer {
  readonly #allowed: ReadonlySet<string>;

  constructor(allowed: Iterable<string> & object = []) {
    if (
      !allowed ||
      (typeof allowed !== "object" && typeof allowed !== "function") ||
      typeof allowed[Symbol.iterator] !== "function"
    ) {
      throw new TypeError("PermissionSet permissions must be an iterable object");
    }
    const permissions = new Set<string>();
    for (const permission of allowed) {
      if (typeof permission !== "string" || !permission || permission.trim() !== permission) {
        throw new TypeError("PermissionSet entry must be a non-empty trimmed string");
      }
      permissions.add(permission);
    }
    this.#allowed = permissions;
    Object.freeze(this);
  }

  readonly authorize = ({ artifact }: AdmissionRequest, signal: AbortSignal) => {
    signal.throwIfAborted();
    const denied = artifact.manifest.permissions.filter(
      (permission) => !this.#allowed.has(permission),
    );
    if (denied.length) throw new PermissionDeniedError(artifact.manifest.name, denied);
  };
}
