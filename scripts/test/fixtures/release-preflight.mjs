import { readFileSync, writeFileSync } from "node:fs";
import { installCommandFixture } from "../release-command-fixture.mjs";

const response = JSON.parse(readFileSync("response.json", "utf8"));

installCommandFixture((name, args, options, nativeSpawn) => {
  if (name === "git") {
    if (args[0] === "rev-parse") {
      return { status: 0, stdout: args.includes("--abbrev-ref") ? "main" : "a".repeat(40) };
    }
    if (args[0] === "rev-list") return { status: 0, stdout: "0" };
    if (["status", "fetch"].includes(args[0]) || (args[0] === "tag" && args[1] === "--list")) {
      return { status: 0 };
    }
    process.exit(99);
  }

  if (name === "npm" && args[0] === "view") {
    if (args.length !== 5 || args.slice(2).join(" ") !== "version --prefer-online --json") {
      process.exit(99);
    }
    if (response.missing) return nativeSpawn(name, args, options);
    const queries = JSON.parse(readFileSync("queries.json", "utf8"));
    queries.push(args[1]);
    writeFileSync("queries.json", JSON.stringify(queries));
    if (response.signal) {
      return nativeSpawn(
        process.execPath,
        ["-e", "process.kill(process.pid, " + JSON.stringify(response.signal) + ")"],
        options,
      );
    }
    return {
      status: response.status,
      stdout: response.stdout,
    };
  }

  if (name === "pnpm" && args.length === 1 && args[0] === "check") {
    writeFileSync("gate-started", JSON.stringify(args));
    return { status: 1 };
  }
  process.exit(99);
});
