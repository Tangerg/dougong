import { expect, it } from "vitest";
import { packageEntrypoints } from "../packages.mjs";

const root = { types: "./dist/index.d.ts", import: "./dist/index.js" };

it("rejects uninspected resolver conditions instead of certifying only the Node import branch", () => {
  expect(() =>
    packageEntrypoints({
      name: "fixture",
      type: "module",
      exports: {
        ".": { browser: "./missing-browser.js", ...root },
      },
    }),
  ).toThrow("export conditions");
});

it("requires literal entrypoints so both tools can check the complete set of shipped targets", () => {
  expect(() =>
    packageEntrypoints({
      name: "fixture",
      type: "module",
      exports: {
        ".": root,
        "./*": { types: "./dist/*.d.ts", import: "./dist/*.js" },
      },
    }),
  ).toThrow("invalid public subpath");
});
