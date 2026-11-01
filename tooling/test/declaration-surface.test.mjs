import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { declarationSurface } from "../architecture/declaration-surface.mjs";

it("distinguishes a class constructor from a type-only re-export through an intermediate barrel", () => {
  const directory = mkdtempSync(join(tmpdir(), "dougong-surface-"));
  try {
    writeFileSync(
      join(directory, "module.d.ts"),
      "export declare class Runtime {}\nexport declare class Hidden {}\n",
    );
    writeFileSync(
      join(directory, "middle.d.ts"),
      'export type { Hidden as Model } from "./module.js";\n',
    );
    const entry = join(directory, "main.d.ts");
    writeFileSync(entry, 'export { Runtime } from "./module.js"; export * from "./middle.js";\n');
    expect(declarationSurface(entry)).toEqual({ values: ["Runtime"], types: ["Model"] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
