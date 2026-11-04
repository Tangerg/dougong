import { readFileSync, writeFileSync } from "node:fs";
import { cleanReleaseGit, installReleaseFixture } from "../release-command-fixture.mjs";

const response = JSON.parse(readFileSync("response.json", "utf8"));

installReleaseFixture((name, commandArguments, options, nativeSpawn) => {
  const commands = JSON.parse(readFileSync("commands.json", "utf8"));
  commands.push({ name, commandArguments });
  writeFileSync("commands.json", JSON.stringify(commands));
  if (name === "git") {
    return cleanReleaseGit(commandArguments, options);
  }

  if (name === "npm" && commandArguments[0] === "view") {
    if (
      commandArguments.length !== 5 ||
      commandArguments.slice(2).join(" ") !== "version --prefer-online --json"
    ) {
      process.exit(99);
    }
    if (response.missing) return nativeSpawn(name, commandArguments, options);
    const queries = JSON.parse(readFileSync("queries.json", "utf8"));
    queries.push(commandArguments[1]);
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

  if (name === "pnpm" && commandArguments.length === 1 && commandArguments[0] === "check") {
    writeFileSync("gate-started", JSON.stringify(commandArguments));
    return { status: 1 };
  }
  process.exit(99);
});
