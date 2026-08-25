import type { Awaitable } from "@dougongjs/core";
import type { Manifest } from "./manifest";
import { PermissionDeniedError } from "./errors";

/**
 * A policy port, not a sandbox.
 *
 * Denying a permission stops Dougong from loading the module. It does nothing to
 * constrain code that is already running: an admitted module has the same
 * capabilities as any other module in the runtime. Real isolation needs a real
 * boundary — a Worker, an iframe, a separate process — and that boundary lives
 * outside Dougong.
 *
 * `authorize` is async and receives a signal, so an implementation may prompt a
 * user or call a remote service, and a Platform change that is abandoned can
 * cancel the prompt.
 */
export interface Authorizer {
  readonly authorize: (manifest: Manifest, signal: AbortSignal) => Awaitable<void>;
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

  readonly authorize = (manifest: Manifest, signal: AbortSignal) => {
    signal.throwIfAborted();
    const denied = manifest.permissions.filter((permission) => !this.#allowed.has(permission));
    if (denied.length) throw new PermissionDeniedError(manifest.name, denied);
  };
}
