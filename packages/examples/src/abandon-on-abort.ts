// Only use this policy when the operation's late values and failures are safe to ignore.
export function abandonOnAbort<T>(signal: AbortSignal, start: () => PromiseLike<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });

    void Promise.resolve()
      .then(() => {
        // A separate reaction for start would allow abort to arrive after the check.
        signal.throwIfAborted();
        return start();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}
