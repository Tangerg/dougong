export function assertAbortRuntime(any: unknown): void;
export function listenForAbort(signal: AbortSignal, notify: () => void): () => void;
