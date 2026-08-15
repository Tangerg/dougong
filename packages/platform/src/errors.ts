import { DougongError } from "@dougongjs/core";

export class PlatformError extends DougongError {
  override name = "PlatformError";

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
  }
}

export class PermissionDeniedError extends PlatformError {
  override name = "PermissionDeniedError";
  readonly denied: ReadonlyArray<string>;

  constructor(
    readonly manifestName: string,
    denied: ReadonlyArray<string>,
  ) {
    const immutableDenied = Object.freeze([...denied]);
    super(
      "PERMISSION_DENIED",
      `Manifest '${manifestName}' was denied permissions: ${immutableDenied.join(", ")}`,
    );
    this.denied = immutableDenied;
  }
}
