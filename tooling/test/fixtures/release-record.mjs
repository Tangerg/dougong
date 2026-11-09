import { execFileSync } from "node:child_process";
import filesystem, { readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { inspectReleaseRepository } from "../../release/release-repository.mjs";
import { versionedManifest } from "../../release/release-request.mjs";
import { ReleaseSession } from "../../release/release-session.mjs";
import { installReleaseFixture } from "../release-command-fixture.mjs";

const scenario = process.argv[2];
const version = "1.1.0";
const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).trim();
const packages = ["reactive", "dougong", "platform"].map((name) => {
  const directory = `packages/${name}`;
  const original = readFileSync(join(directory, "package.json"));
  return {
    directory,
    name,
    original,
    currentVersion: "1.0.0",
    versioned: versionedManifest(original, version),
  };
});
const request = {
  version,
  packages,
  manifestFiles: packages.map(({ directory }) => `${directory}/package.json`),
  resumeCommand: "fixture",
  assertVersionedManifests() {
    for (const { directory, versioned } of packages) {
      if (!readFileSync(join(directory, "package.json")).equals(versioned))
        throw new Error("Fixture manifest changed");
    }
  },
};
const session = new ReleaseSession();
const observation = {};
const observeIndex = () => {
  observation.index = readFileSync(git(["rev-parse", "--git-path", "index"])).toString("base64");
};
try {
  const repository = await inspectReleaseRepository(session, request);
  session.replaceManifests(packages, repository.source);
  if (
    ["after-effect-failure", "readback-failure", "head-after-record", "ref-after-record"].includes(
      scenario,
    )
  ) {
    let recorded = false;
    if (scenario === "head-after-record") {
      git(["branch", "another-owner", repository.source.head]);
      observation.otherOwnerHead = repository.source.head;
    }
    installReleaseFixture((command, args, options, nativeSpawn) => {
      if (command !== "git") throw new Error("Recording fixture permits only local Git");
      if (
        recorded &&
        scenario === "readback-failure" &&
        args[0] === "rev-parse" &&
        args[1] === "--verify"
      )
        return { status: 1, stderr: "Fixture ref readback failed" };
      const run = (arguments_) => nativeSpawn("git", arguments_, { ...options, stdio: "pipe" });
      const result = run([...options.gitConfigurationArguments, ...args]);
      if (args[0] === "update-ref" && result.status === 0) {
        recorded = true;
        const releaseCommit = args.at(-2);
        observation.releaseCommit = releaseCommit;
        if (scenario === "head-after-record") {
          const switched = run(["symbolic-ref", "HEAD", "refs/heads/another-owner"]);
          if (switched.status !== 0) throw new Error(switched.stderr.toString());
        }
        if (scenario === "ref-after-record") {
          const advanced = run([
            "commit-tree",
            `${releaseCommit}^{tree}`,
            "-p",
            releaseCommit,
            "-m",
            "Another owner's later commit",
          ]);
          if (advanced.status !== 0) throw new Error(advanced.stderr.toString());
          observation.otherOwnerHead = advanced.stdout.toString().trim();
          const updated = run([
            "update-ref",
            "refs/heads/main",
            observation.otherOwnerHead,
            releaseCommit,
          ]);
          if (updated.status !== 0) throw new Error(updated.stderr.toString());
        }
        if (scenario === "after-effect-failure" || scenario === "readback-failure")
          return {
            ...result,
            status: 1,
            stderr: Buffer.from("Fixture lost ref-update acknowledgement"),
          };
      }
      return result;
    });
  }
  if (scenario === "existing-lock")
    writeFileSync(".git/index.lock", "another owner's lock", { flag: "wx" });
  if (scenario === "staged-files") {
    writeFileSync("other.txt", "staged by another owner\n");
    git(["add", "other.txt"]);
    writeFileSync("other.txt", "working tree belongs to another owner\n");
  }
  if (scenario === "staged-manifest") git(["add", "packages/dougong/package.json"]);
  if (scenario === "commit-hooks") {
    for (const name of ["pre-commit", "commit-msg", "post-commit", "post-index-change"])
      writeFileSync(
        `.git/hooks/${name}`,
        "#!/bin/sh\nprintf 'unverified hook ran' > .git/unverified-hook\nexit 1\n",
        { mode: 0o755 },
      );
  }
  if (scenario === "clean-filter" || scenario === "cleanup-failure") {
    writeFileSync(".git/info/attributes", "packages/*/package.json filter=release\n");
    writeFileSync(
      ".git/clean-filter.cjs",
      'process.stdout.write(require("node:fs").readFileSync(0, "utf8").replace(/1\\.1\\.0/g, "9.9.9"));\n',
    );
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    git([
      "config",
      "filter.release.clean",
      `${quote(process.execPath)} ${quote(join(process.cwd(), ".git/clean-filter.cjs"))}`,
    ]);
    git(["config", "filter.release.required", "true"]);
  }
  if (scenario === "cleanup-failure") {
    const remove = filesystem.rmSync;
    let failCleanup = true;
    filesystem.rmSync = (path, options) => {
      if (failCleanup && path === resolve(".git/index.lock")) {
        failCleanup = false;
        throw new Error("Fixture index cleanup failed");
      }
      return remove(path, options);
    };
    syncBuiltinESMExports();
  }
  observeIndex();
  const atSource = session.atSource.bind(session);
  let inject = ["same-sha", "different-sha"].includes(scenario);
  session.atSource = async (source) => {
    const matches = await atSource(source);
    if (inject) {
      inject = false;
      git(["switch", "-c", "another-owner"]);
      if (scenario === "different-sha")
        git(["commit", "--allow-empty", "-m", "Another owner's checkpoint"]);
      observation.otherOwnerHead = git(["rev-parse", "HEAD"]);
      observeIndex();
    }
    return matches;
  };
  if (
    [
      "advanced-ref",
      "changed-symref",
      "aliased-main",
      "cancel-before-record",
      "projection-failure",
    ].includes(scenario)
  ) {
    const recordCommit = session.recordCommit.bind(session);
    session.recordCommit = async (record, indexProjection) => {
      if (scenario === "advanced-ref") {
        observation.otherOwnerHead = git([
          "commit-tree",
          `${repository.source.head}^{tree}`,
          "-p",
          repository.source.head,
          "-m",
          "Another owner's ref update",
        ]);
        git(["update-ref", "refs/heads/main", observation.otherOwnerHead, repository.source.head]);
      }
      if (scenario === "changed-symref" || scenario === "aliased-main") {
        git(["branch", "another-owner", repository.source.head]);
        git([
          "symbolic-ref",
          scenario === "changed-symref" ? "HEAD" : "refs/heads/main",
          "refs/heads/another-owner",
        ]);
        observation.otherOwnerHead = repository.source.head;
      }
      if (scenario === "cancel-before-record") process.kill(process.pid, "SIGTERM");
      if (scenario === "projection-failure") {
        observation.releaseCommit = record.commit;
        return recordCommit(record, {
          ...indexProjection,
          publish() {
            throw new Error("Fixture index publication failed");
          },
        });
      }
      return recordCommit(record, indexProjection);
    };
  }
  await repository.record();
  observation.recorded = true;
} catch (error) {
  observation.recorded = false;
  observation.error = error.message;
  if (error !== session.signal.reason) console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync("record-observation.json", JSON.stringify(observation));
  await session.close();
}
