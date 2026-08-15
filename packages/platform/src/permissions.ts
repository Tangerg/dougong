import type { Manifest } from "./manifest";
import { PermissionDeniedError } from "./errors";

export interface Authorizer {
  authorize(manifest: Manifest, signal: AbortSignal): void | Promise<void>;
}

/** An immutable allow-list policy; custom interactive policies implement the same port. */
export class PermissionSet implements Authorizer {
  readonly #allowed: ReadonlySet<string>;

  constructor(allowed: Iterable<string> = []) {
    this.#allowed = new Set(allowed);
  }

  authorize(manifest: Manifest, signal: AbortSignal) {
    signal.throwIfAborted();
    const denied = manifest.permissions.filter((permission) => !this.#allowed.has(permission));
    if (denied.length) throw new PermissionDeniedError(manifest.name, denied);
  }
}
