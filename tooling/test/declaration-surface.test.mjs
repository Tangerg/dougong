import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { declarationSurface } from "../architecture/declaration-surface.mjs";

it("distinguishes a class constructor from a type-only re-export through an intermediate barrel", () => {
  const dir = mkdtempSync(join(tmpdir(), "dougong-surface-"));
  try {
    writeFileSync(
      join(dir, "module.d.ts"),
      "export declare class Runtime {}\nexport declare class Hidden {}\n",
    );
    writeFileSync(
      join(dir, "middle.d.ts"),
      'export type { Hidden as Model } from "./module.js";\n',
    );
    const entry = join(dir, "main.d.ts");
    writeFileSync(entry, 'export { Runtime } from "./module.js"; export * from "./middle.js";\n');
    expect(declarationSurface(entry)).toEqual({ values: ["Runtime"], types: ["Model"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
