import { expect, it } from "vitest";
import { errorDocumentationFailures } from "../architecture/error-code-surface.mjs";

const sourceCodes = new Set(["HOST_BUSY", "HOST_QUARANTINED"]);
const guidePath = "docs/guide/example.md";

it("keeps technical terminology outside the error-code domain", () => {
  const text = "Use `HTTP`, `HEAD`, and `APP_PORT` when describing transport and configuration.";
  expect(errorDocumentationFailures(guidePath, text, sourceCodes)).toEqual([]);
});

it("rejects unknown or retired explicitly linked error references", () => {
  const text = [
    "[`HOST_BUSY`](../reference/errors.md)",
    "[`HOST_QUARANTINED`](../reference/errors.md#quarantine)",
    "[`HOST_BSY`](../reference/errors.md)",
    "[`PLUGIN_CYCLE`](../reference/errors.md)",
    "[`HTTP`](https://example.test/errors.md)",
    "[`HTTP`](./errors.md)",
  ].join("\n");
  expect(errorDocumentationFailures(guidePath, text, sourceCodes)).toEqual([
    "documents 'HOST_BSY', which no source throws",
    "documents 'PLUGIN_CYCLE', which no source throws",
  ]);
});

it("requires the canonical table to cover every source code, independent of prose references", () => {
  const text = [
    "| Code | Meaning |",
    "| --- | --- |",
    "| `HOST_BUSY` | Wait for active work. |",
    "| `HOST_BSY` | Misspelled. |",
    "[`HOST_QUARANTINED`](./errors.md)",
  ].join("\n");
  expect(errorDocumentationFailures("docs/reference/errors.md", text, sourceCodes)).toEqual([
    "documents 'HOST_BSY', which no source throws",
    "error code 'HOST_QUARANTINED' is not documented",
  ]);
});

it("checks explicit error constructions without assigning application fields to the error domain", () => {
  const source = [
    "```ts",
    'if (error.code === "HOST_BUSY") retry();',
    'if ("HOST_BSY" === error["code"]) retry();',
    'switch (error.code) { case "PLUGIN_CYCLE": break; }',
    'throw new DougongError("MISSING_CODE", "Example");',
    'throw new PlatformError("RETIRED_CODE", "Example");',
    'const transport = "HTTP";',
    "```",
  ].join("\n");
  expect(errorDocumentationFailures(guidePath, source, sourceCodes)).toEqual([
    "documents 'MISSING_CODE', which no source throws",
    "documents 'RETIRED_CODE', which no source throws",
  ]);
});
