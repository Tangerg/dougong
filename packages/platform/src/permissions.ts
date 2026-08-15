import type { Manifest } from "./manifest";
import { PermissionDeniedError } from "./errors";

export interface Authorizer {
  authorize(manifest: Manifest, signal: AbortSignal): void | Promise<void>;
}

/** An immutable allow-list policy; custom interactive policies implement the same port. */
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
      if (typeof permission !== "string" || !permission.trim()) {
        throw new TypeError("PermissionSet entry must be a non-empty string");
      }
      if (permission !== permission.trim()) {
        throw new TypeError("PermissionSet entry cannot start or end with whitespace");
      }
      permissions.add(permission);
    }
    this.#allowed = permissions;
  }

  authorize(manifest: Manifest, signal: AbortSignal) {
    signal.throwIfAborted();
    const denied = manifest.permissions.filter((permission) => !this.#allowed.has(permission));
    if (denied.length) throw new PermissionDeniedError(manifest.name, denied);
  }
}
