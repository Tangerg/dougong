import { expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import typescript from "typescript";
import {
  sourceErrorCodes,
  errorDocumentationFailures,
} from "../architecture/error-code-surface.mjs";

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

it("derives the error catalogue from resolved code types across aliases, conditions and subclasses", () => {
  const directory = mkdtempSync(join(tmpdir(), "dougong-error-codes-"));
  try {
    const definitions = join(directory, "definitions.ts");
    const entrypoint = join(directory, "index.ts");
    const consumer = join(directory, "consumer.ts");
    writeFileSync(
      definitions,
      `
      export const waitingCode = "WAITING";
      export const closedCode = "CLOSED";
      export const unusedCode = "UNUSED";
      export class StructuredError<Code extends string = string> {
        constructor(readonly code: Code) {}
      }
    `,
    );
    writeFileSync(entrypoint, `export { StructuredError as Failure } from "./definitions.js";`);
    writeFileSync(
      consumer,
      `
      import { Failure as RenamedError } from "./index.js";
      import { waitingCode as pendingCode, closedCode } from "./definitions.js";
      export function pending(waiting: boolean) {
        const code = waiting ? pendingCode : closedCode;
        return new RenamedError(code);
      }
      export class InheritedError<Code extends string> extends RenamedError<Code> {}
      export const inherited = new InheritedError("INHERITED");
      export class LabelledError extends RenamedError {
        constructor(label: string) {
          super("LABELLED");
        }
      }
      export const labelled = new LabelledError("LABEL_IS_NOT_A_CODE");
      export class TypedError extends RenamedError<"FIRST" | "SECOND"> {
        constructor(code: "FIRST" | "SECOND") {
          super(code);
        }
      }
      export const typed = new TypedError("FIRST");
      class DougongError {
        constructor(readonly code: "UNRELATED") {}
      }
      export const unrelated = new DougongError("UNRELATED");
    `,
    );
    const program = typescript.createProgram([definitions, entrypoint, consumer], {
      noEmit: true,
      noLib: true,
      types: [],
      strict: true,
      target: typescript.ScriptTarget.Latest,
      module: typescript.ModuleKind.ESNext,
      moduleResolution: typescript.ModuleResolutionKind.Bundler,
    });

    expect([...sourceErrorCodes(program, entrypoint, "Failure")].sort()).toEqual([
      "CLOSED",
      "FIRST",
      "INHERITED",
      "LABELLED",
      "SECOND",
      "WAITING",
    ]);
    expect(() => sourceErrorCodes(program, definitions, "waitingCode")).toThrow(
      "must export error class",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
