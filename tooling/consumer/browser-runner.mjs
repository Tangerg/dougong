import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const consumerOrigin = "https://dougong.test/";
const executionTimeoutMilliseconds = 30_000;

async function executeConsumer(page, entry) {
  let timer;
  try {
    await Promise.race([
      page.evaluate(async (url) => {
        const { verifyBrowserConsumer } = await import(url);
        await verifyBrowserConsumer();
      }, entry),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Browser consumer did not finish its ownership lifecycle")),
          executionTimeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyBrowserBundle(output) {
  const scripts = new Map(
    output.filter((file) => file.type === "chunk").map((chunk) => [chunk.fileName, chunk.code]),
  );
  const entry = output.find((file) => file.type === "chunk" && file.isEntry);
  if (!entry) throw new Error("Browser consumer has no executable entrypoint");

  for (const engine of [chromium, firefox, webkit]) {
    const browser = await engine.launch();
    try {
      for (const maskNativeDisposal of [false, true]) {
        const context = await browser.newContext();
        try {
          if (maskNativeDisposal)
            await context.addInitScript({
              path: fileURLToPath(new URL("./mask-native-disposal.mjs", import.meta.url)),
            });
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error));
          // Serve only the inspected in-memory bundle; the consumer needs no network or workspace imports.
          await page.route("**/*", async (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== new URL(consumerOrigin).origin) return route.abort();
            if (url.pathname === "/")
              return route.fulfill({
                contentType: "text/html",
                body: "<!doctype html><meta charset=utf-8><title>Dougong consumer</title>",
              });
            const script = scripts.get(url.pathname.slice(1));
            if (script === undefined) return route.abort();
            return route.fulfill({ contentType: "text/javascript", body: script });
          });
          await page.goto(consumerOrigin);
          await executeConsumer(page, new URL(entry.fileName, consumerOrigin).href);
          if (errors.length) throw new AggregateError(errors, "Browser consumer raised errors");
          console.log(
            `Packed consumer OK: ${engine.name()} with ${maskNativeDisposal ? "registered" : "runtime"} disposal symbols`,
          );
        } catch (error) {
          throw new Error(
            `${engine.name()} consumer failed (${maskNativeDisposal ? "registered" : "runtime"} disposal symbols)`,
            { cause: error },
          );
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
}
