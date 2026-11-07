import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("rejects asynchronous abort callbacks on both entry paths without losing their rejections", () => {
  const abortSource = new URL("../src/internal/abort.ts", import.meta.url).href;
  const resultSource = new URL("../src/internal/async-result.ts", import.meta.url).href;
  // Native EventTarget reports listener throws outside the caller; isolate that channel from Vitest.
  const program = `
    import { registerHooks } from "node:module";
    const abortSource = ${JSON.stringify(abortSource)};
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL === abortSource && specifier === "./async-result.js")
          return { url: ${JSON.stringify(resultSource)}, shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    const { onAbort } = await import(abortSource);
    const unhandled = [];
    process.on("unhandledRejection", (error) => unhandled.push(error));
    const results = [];
    for (const timing of ["already", "later"]) {
      for (const kind of ["promise", "thenable", "throw"]) {
        const controller = new AbortController();
        const reason = new Error("cancellation requested");
        const failure = new Error("callback failed");
        const errors = [];
        const captureError = (error) => errors.push(error);
        process.on("uncaughtException", captureError);
        let calls = 0;
        let sameReason = false;
        let thenCalls = 0;
        let sameReceiver = true;
        const thenable = {
          then(resolve, reject) {
            thenCalls++;
            sameReceiver = this === thenable;
            reject(failure);
          },
        };
        if (timing === "already") controller.abort(reason);
        let detach;
        try {
          detach = onAbort(controller.signal, (received) => {
            calls++;
            sameReason = received === reason;
            if (kind === "throw") throw failure;
            return kind === "promise" ? Promise.reject(failure) : thenable;
          });
        } catch (error) {
          errors.push(error);
        }
        controller.abort(reason);
        controller.signal.dispatchEvent(new Event("abort"));
        detach?.();
        detach?.();
        await new Promise((resolve) => setImmediate(resolve));
        process.removeListener("uncaughtException", captureError);
        const [error] = errors;
        results.push({
          timing,
          kind,
          calls,
          sameReason,
          failureVisible: errors.length === 1 && (kind === "throw"
            ? error === failure
            : error instanceof TypeError && error.message === "Abort listeners must be synchronous"),
          thenCalls,
          sameReceiver,
        });
      }
    }
    console.log(JSON.stringify({ results, unhandled: unhandled.length }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(JSON.parse(output)).toEqual({
    results: ["already", "later"].flatMap((timing) =>
      ["promise", "thenable", "throw"].map((kind) => ({
        timing,
        kind,
        calls: 1,
        sameReason: true,
        failureVisible: true,
        thenCalls: kind === "thenable" ? 1 : 0,
        sameReceiver: true,
      })),
    ),
    unhandled: 0,
  });
});
