import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("detects and repairs resolver drift for the shared cancellation protocol", () => {
  const root = mkdtempSync(join(tmpdir(), "dougong-generated-runtime-"));
  try {
    mkdirSync(join(root, "tooling"));
    for (const file of ["internal", "generate-internal.mjs", "packages.mjs"]) {
      cpSync(new URL(`../${file}`, import.meta.url), join(root, "tooling", file), {
        recursive: true,
      });
    }
    for (const name of ["dougong", "reactive"]) {
      const directory = join(root, "packages", name);
      mkdirSync(directory, { recursive: true });
      cpSync(
        new URL(`../../packages/${name}/package.json`, import.meta.url),
        join(directory, "package.json"),
      );
    }
    const generate = (...commandArguments) => {
      const result = spawnSync(
        process.execPath,
        [join(root, "tooling/generate-internal.mjs"), ...commandArguments],
        { encoding: "utf8" },
      );
      if (result.error) throw result.error;
      return result;
    };
    expect(generate().status).toBe(0);
    const file = join(root, "packages/reactive/package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    const original = manifest.imports["#abort-listener"];
    manifest.imports["#abort-listener"] = { development: "./runtime/missing.mjs", ...original };
    manifest.imports["#application"] = "./application.js";
    writeFileSync(file, JSON.stringify(manifest));
    const checked = generate("--check");
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain("#abort-listener");
    expect(generate().status).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      ...manifest,
      imports: { ...manifest.imports, "#abort-listener": original },
    });
    expect(generate("--check").status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
