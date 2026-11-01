import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { installConsumerDependencies } from "../consumer/install-dependencies.mjs";

it.each(["actual", "aliased"])(
  "preserves each importer’s installed %s package and shared module identity offline",
  (request) => {
    const fixture = mkdtempSync(join(tmpdir(), "dougong-consumer-dependencies-"));
    const checkout = join(fixture, "checkout");
    const consumer = join(fixture, "consumer");
    const root = join(consumer, "node_modules", "application");
    function writePackage(directory, name, dependencies, body, extra = {}) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ name, dependencies, ...extra }),
      );
      writeFileSync(join(directory, "index.js"), body);
    }
    try {
      for (const directory of [checkout, root])
        writePackage(
          directory,
          "application",
          { left: "*", right: "*" },
          "module.exports = [require('left'), require('right')];",
        );
      const modules = join(checkout, "node_modules");
      for (const [parent, version] of [
        ["left", "v1"],
        ["right", "v2"],
      ]) {
        const directory = join(modules, parent);
        writePackage(
          directory,
          parent,
          { [request]: request === "actual" ? version : `npm:actual@${version}`, shared: "*" },
          `module.exports = { version: require('${request}'), shared: require('shared') };`,
        );
        writePackage(
          join(directory, "node_modules", request),
          "actual",
          {},
          `module.exports = '${version}';`,
        );
      }
      writePackage(join(modules, "shared"), "shared", {}, "module.exports = {};", {
        optionalDependencies: { absent: "*" },
      });
      installConsumerDependencies(new Map([[checkout, root]]), join(consumer, "copies"));
      rmSync(checkout, { recursive: true });
      const require = createRequire(join(consumer, "consumer.cjs"));
      const [left, right] = require(root);
      expect([left.version, right.version]).toEqual(["v1", "v2"]);
      expect(left.shared).toBe(right.shared);
      expect(realpathSync(join(root, "node_modules", "left"))).toContain(consumer);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
