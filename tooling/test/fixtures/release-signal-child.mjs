import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const {
  parent,
  signal,
  workspace,
  stage,
  boundary,
  descendant,
  role = "command",
} = JSON.parse(process.argv[2]);
if (
  process.cwd() !== workspace ||
  !basename(workspace).startsWith("dougong-release-artifacts-test-") ||
  dirname(realpathSync(workspace)) !== realpathSync(tmpdir()) ||
  !basename(stage).startsWith("dougong-release-") ||
  dirname(realpathSync(stage)) !== realpathSync(tmpdir()) ||
  !["SIGINT", "SIGTERM", "SIGHUP"].includes(signal)
) {
  throw new Error("Signal fixture requires its isolated release workspace and stage");
}

function record(event, details = {}) {
  appendFileSync(
    join(workspace, "release-operations.jsonl"),
    JSON.stringify({ command: "signal-probe", event, role, boundary, signal, ...details }) + "\n",
  );
}

const cleanupDelayMilliseconds = 100;
let finishing = false;
function finish() {
  if (finishing) return;
  finishing = true;
  const stageExists = existsSync(stage);
  const manifestVersions = ["reactive", "dougong", "platform"].map(
    (directory) =>
      JSON.parse(readFileSync(join(workspace, "packages", directory, "package.json"))).version,
  );
  if (stageExists)
    writeFileSync(join(stage, `${role}-last-write`), "command is still using its stage\n");
  record("last-write", { stageExists, manifestVersions });
  process.exit(0);
}

process.once(signal, () => {
  record("received");
  if (descendant && role === "command") {
    record("leader-exit");
    process.exit(0);
  }
  setTimeout(finish, cleanupDelayMilliseconds);
});

if (role === "descendant") {
  process.send("ready");
  process.once("disconnect", () => setTimeout(finish, cleanupDelayMilliseconds));
} else {
  if (descendant) {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        JSON.stringify({
          parent,
          signal,
          workspace,
          stage,
          boundary,
          descendant,
          role: "descendant",
        }),
      ],
      { cwd: workspace, stdio: ["ignore", "inherit", "inherit", "ipc"] },
    );
    await new Promise((resolveReady, reject) => {
      child.once("message", resolveReady);
      child.once("error", reject);
    });
  }
  record("sent", { parent });
  process.kill(parent, signal);
  // Returning successfully also exposes the original spawnSync bug when its parent cannot handle the signal yet.
  setTimeout(finish, cleanupDelayMilliseconds);
}
