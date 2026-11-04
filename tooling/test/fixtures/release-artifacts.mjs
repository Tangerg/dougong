import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import timers from "node:timers/promises";
import {
  candidateOutput,
  packCandidates,
  writeVerifiedCandidates,
} from "../../consumer/package-candidates.mjs";
import { cleanReleaseGit, installReleaseFixture } from "../release-command-fixture.mjs";

const workspace = process.cwd();
const visibility = process.env.DOUGONG_RELEASE_VISIBILITY;
const queryMilliseconds = Number(process.env.DOUGONG_RELEASE_QUERY_MILLISECONDS ?? 0);
let elapsedMilliseconds = 0;
let terminationRequested = false;
Object.defineProperty(performance, "now", { value: () => elapsedMilliseconds });
function recordClock() {
  writeFileSync(join(workspace, "release-clock.json"), JSON.stringify({ elapsedMilliseconds }));
}
recordClock();
process.once("exit", recordClock);
if (!["immediate", "delayed", "never", "unreadable"].includes(visibility)) {
  throw new TypeError(`Unknown fixture visibility: ${visibility}`);
}

timers.setTimeout = async (delayMilliseconds) => {
  if (!Number.isInteger(delayMilliseconds) || delayMilliseconds < 1) {
    throw new TypeError(`Invalid fixture timer delay: ${delayMilliseconds}`);
  }
  appendFileSync(
    join(workspace, "release-operations.jsonl"),
    JSON.stringify({ delayMilliseconds, elapsedMilliseconds }) + "\n",
  );
  // A synchronous clock advance would conceal a caller that forgot to await the timer.
  await Promise.resolve();
  elapsedMilliseconds += delayMilliseconds;
  if (visibility === "delayed") {
    const pending = join(workspace, "pending");
    mkdirSync(join(workspace, "published"), { recursive: true });
    for (const directory of readdirSync(pending)) {
      renameSync(join(pending, directory), join(workspace, "published", directory));
    }
  } else if (visibility !== "never") {
    throw new Error(`Unexpected registry polling wait: ${visibility}`);
  }
  const terminationSignal = process.env.DOUGONG_RELEASE_TERMINATION_SIGNAL;
  if (terminationSignal) {
    if (!["SIGINT", "SIGTERM", "SIGHUP"].includes(terminationSignal)) {
      throw new TypeError(`Unknown release termination signal: ${terminationSignal}`);
    }
    recordClock();
    terminationRequested = true;
    process.kill(process.pid, terminationSignal);
    // Keep the real release suspended until the signal reaches its installed handler.
    const terminationWaitIntervalMilliseconds = 1_000;
    await new Promise(() => setInterval(() => undefined, terminationWaitIntervalMilliseconds));
  }
};
syncBuiltinESMExports();

function packageAt(state, reference) {
  const root = join(workspace, state);
  if (!existsSync(root)) return undefined;
  return readdirSync(root)
    .map((directory) => join(root, directory))
    .find((directory) => {
      const manifest = JSON.parse(readFileSync(join(directory, "package/package.json"), "utf8"));
      return `${manifest.name}@${manifest.version}` === reference;
    });
}

const registryTagsPath = join(workspace, "dist-tags.json");
function registryTags() {
  return existsSync(registryTagsPath) ? JSON.parse(readFileSync(registryTagsPath, "utf8")) : {};
}

let injected = false;
let sourceComparisons = 0;
let previousPack;
installReleaseFixture((name, commandArguments, options, nativeSpawn) => {
  const race = process.env.DOUGONG_RELEASE_CONCURRENT_EDIT;
  const git = process.env.DOUGONG_RELEASE_REAL_GIT;
  if (race && git && !injected) {
    const runGit = (...commandArguments) => {
      const result = nativeSpawn(git, commandArguments, { cwd: workspace, stdio: "pipe" });
      if (result.status !== 0) throw new Error("Concurrent Git fixture failed: " + result.stderr);
    };
    if (
      race === "build-before-pack" &&
      name === "pnpm" &&
      commandArguments[0] === "pack" &&
      basename(options.cwd) === "dougong"
    ) {
      writeFileSync(join(options.cwd, "dist/index.js"), "export const notTheTestedBuild = true;");
      injected = true;
    }
    if (name === "npm" && commandArguments[0] === "publish") {
      if (race === "stage") {
        writeFileSync(join(workspace, "other.txt"), "owned by another operation\n");
        runGit("add", "other.txt");
        injected = true;
      } else if (race === "manifest") {
        const path = join(workspace, "packages/dougong/package.json");
        const contents = JSON.parse(readFileSync(path));
        contents.description = "Concurrent manifest edit";
        writeFileSync(path, JSON.stringify(contents, null, 2) + "\n");
        injected = true;
      } else if (race === "head") {
        runGit("commit", "--allow-empty", "-m", "Concurrent source commit");
        injected = true;
      }
    }
    if (
      race === "before-publish" &&
      name === "pnpm" &&
      commandArguments[0] === "pack" &&
      basename(options.cwd) === "platform"
    ) {
      runGit("commit", "--allow-empty", "-m", "Concurrent commit during packing");
      injected = true;
    }
    if (
      race === "tag-head" &&
      name === "git" &&
      commandArguments[0] === "tag" &&
      commandArguments.includes("-a")
    ) {
      runGit("commit", "--allow-empty", "-m", "Concurrent commit before tag");
      injected = true;
    }
    if (race === "retag-during-resume" && name === "pnpm" && commandArguments[0] === "pack") {
      const { version } = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
      const tag = `v${version}`;
      const existing = nativeSpawn(git, ["tag", "--list", tag], {
        cwd: workspace,
        encoding: "utf8",
      });
      if (existing.stdout.trim()) {
        runGit("tag", "-f", "-a", tag, "-m", "A different annotation for the same commit");
        injected = true;
      }
    }
    if (race === "remote-main-at-push" && name === "git" && commandArguments[0] === "push") {
      runGit("-C", join(workspace, "remote.git"), "update-ref", "-d", "refs/heads/main");
      injected = true;
    }
    if (race === "remote-tag-during-gate" && name === "pnpm" && commandArguments[0] === "pack") {
      const { version } = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
      runGit(
        "-C",
        join(workspace, "remote.git"),
        "update-ref",
        `refs/tags/v${version}`,
        "refs/heads/main",
      );
      injected = true;
    }
    if (race === "remote-tag-at-push" && name === "git" && commandArguments[0] === "push") {
      const tagReference = commandArguments.at(-1).split(":")[1];
      const original = nativeSpawn(git, ["rev-parse", "origin/main"], {
        cwd: workspace,
        encoding: "utf8",
      }).stdout.trim();
      runGit("-C", join(workspace, "remote.git"), "update-ref", tagReference, original);
      injected = true;
    }
    if (race === "push-refs" && name === "git" && commandArguments[0] === "push") {
      const tag =
        "v" + JSON.parse(readFileSync(join(workspace, "packages/dougong/package.json"))).version;
      runGit("commit", "--allow-empty", "-m", "Concurrent commit before push");
      runGit("tag", "-f", "-a", tag, "-m", "Unrelated local tag");
      injected = true;
    }
  }
  const recording =
    name === "git" &&
    (["add", "commit", "push"].includes(commandArguments[0]) ||
      (commandArguments[0] === "tag" && commandArguments.includes("-a")));
  if (recording || name === "npm") {
    appendFileSync(
      join(workspace, "release-operations.jsonl"),
      JSON.stringify({
        command: name,
        commandArguments,
        registryArguments: options.registryArguments,
        gitConfigurationArguments: options.gitConfigurationArguments,
        elapsedMilliseconds,
        timeoutMilliseconds: options.timeout,
        killSignal: options.killSignal,
      }) + "\n",
    );
  }
  if (name === "git") {
    if (
      terminationRequested &&
      process.env.DOUGONG_RELEASE_FAIL_RESTORATION_SOURCE_QUERY === "true" &&
      commandArguments[0] === "rev-parse"
    ) {
      return { status: 1, stderr: "Fixture restoration source query failed" };
    }
    if (process.env.DOUGONG_RELEASE_REAL_GIT) {
      const interrupt =
        (recording || (commandArguments[0] === "diff" && commandArguments.includes("--cached"))) &&
        commandArguments[0] === process.env.DOUGONG_RELEASE_INTERRUPT;
      if (interrupt && process.env.DOUGONG_RELEASE_INTERRUPT_AFTER !== "true") {
        return { status: 1 };
      }
      const result = nativeSpawn(
        process.env.DOUGONG_RELEASE_REAL_GIT,
        [...options.gitConfigurationArguments, ...commandArguments],
        { ...options, stdio: "pipe" },
      );
      if (
        race === "preflight-source" &&
        !injected &&
        commandArguments[0] === "rev-list" &&
        commandArguments[1] === "--count" &&
        ++sourceComparisons === 2
      ) {
        const git = (args, directory = workspace) => {
          const result = nativeSpawn(process.env.DOUGONG_RELEASE_REAL_GIT, args, {
            cwd: directory,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
          });
          if (result.error || result.status !== 0)
            throw new Error("Concurrent Git fixture failed: " + result.stderr);
          return result.stdout.trim();
        };
        const remote = join(workspace, "remote.git");
        if (
          !basename(workspace).startsWith("dougong-release-artifacts-test-") ||
          dirname(realpathSync(workspace)) !== realpathSync(tmpdir()) ||
          git(["remote", "get-url", "origin"]) !== remote ||
          git(["rev-parse", "--is-bare-repository"], remote) !== "true"
        )
          throw new Error("Concurrent source fixture requires its isolated local Git repository");
        writeFileSync(
          join(workspace, "packages/dougong/README.md"),
          "Concurrent unpushed documentation\n",
        );
        git(["add", "packages/dougong/README.md"]);
        const replacement = git([
          "commit-tree",
          git(["write-tree"]),
          "-m",
          "Unpublished unrelated source",
        ]);
        git(["update-ref", "refs/heads/main", replacement]);
        injected = true;
      }
      return { ...result, status: interrupt ? 1 : result.status };
    }
    return cleanReleaseGit(commandArguments, options);
  }

  if (name === "pnpm" && commandArguments.length === 1 && commandArguments[0] === "check") {
    appendFileSync(
      join(workspace, "release-operations.jsonl"),
      JSON.stringify({
        command: "gate-versions",
        commandArguments: ["reactive", "dougong", "platform"].map(
          (directory) =>
            JSON.parse(readFileSync(join(workspace, "packages", directory, "package.json")))
              .version,
        ),
      }) + "\n",
    );
    const output = options.env?.[candidateOutput];
    if (output) {
      writeVerifiedCandidates(output, packCandidates(workspace));
      writeFileSync(join(workspace, "release-stage"), output);
      if (race === "alter-receipt")
        writeFileSync(join(output, "reactive", "reactive.tgz"), "wrong bytes");
    }
    return { status: 0 };
  }

  if (commandArguments[0] === "pack" && (name === "pnpm" || name === "npm")) {
    const stage = commandArguments[commandArguments.indexOf("--pack-destination") + 1];
    let source;
    if (name === "pnpm") {
      if (commandArguments.length !== 3 || commandArguments[1] !== "--pack-destination")
        process.exit(99);
      if (process.env.DOUGONG_RELEASE_REAL_PNPM) {
        return nativeSpawn(process.env.DOUGONG_RELEASE_REAL_PNPM, commandArguments, {
          ...options,
          stdio: "pipe",
          env: { ...process.env, ...options.env, COREPACK_ENABLE_NETWORK: "0" },
        });
      }
      source = join(stage, `pack__${basename(options.cwd)}`);
      mkdirSync(source);
      cpSync(options.cwd, join(source, "package"), { recursive: true });
      if (race === "undeclared-file") writeFileSync(join(source, "package/binding.gyp"), "{}");
      const manifestPath = join(source, "package/package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (basename(options.cwd) === "dougong") {
        Object.assign(manifest, JSON.parse(process.env.DOUGONG_RELEASE_PACKED_OVERRIDES));
      }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } else {
      if (commandArguments.length !== 4 || commandArguments[2] !== "--pack-destination")
        process.exit(99);
      source = packageAt("published", commandArguments[1]);
      if (!source) return { status: 1, stderr: "Package version is not published" };
    }
    const archive = join(stage, basename(name === "pnpm" ? options.cwd : source) + ".tgz");
    const prefix = name === "npm" ? process.env.DOUGONG_RELEASE_PUBLISHED_ARCHIVE_PREFIX : "";
    const packed = nativeSpawn(
      "tar",
      ["-czf", archive, "-C", source, "--", ...readdirSync(source).map((entry) => prefix + entry)],
      { stdio: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    if (packed.error || packed.status !== 0) process.exit(99);
    if (name === "pnpm" && race === "rewrite-pack") {
      if (previousPack && existsSync(previousPack.archive)) {
        writeFileSync(
          join(previousPack.source, "package/dist/index.js"),
          "export const replaced = true;",
        );
        const rewritten = nativeSpawn(
          "tar",
          ["-czf", previousPack.archive, "-C", previousPack.source, "package"],
          { stdio: "pipe" },
        );
        if (rewritten.status !== 0) process.exit(99);
      }
      previousPack = { archive, source };
    }
    if (name === "pnpm" && race === "ambiguous-archive")
      cpSync(archive, join(stage, "another.tgz"));
    return { status: 0, stdout: archive };
  }

  if (name === "npm" && commandArguments[0] === "view") {
    if (commandArguments.slice(2).join(" ") === "dist-tags --prefer-online --json") {
      const directory = packageAt("published", commandArguments[1]);
      if (!directory) return { status: 1 };
      const manifest = JSON.parse(readFileSync(join(directory, "package/package.json"), "utf8"));
      const tags = registryTags()[manifest.name] ?? {};
      return { status: 0, stdout: JSON.stringify(tags) };
    }
    if (
      commandArguments.length !== 5 ||
      commandArguments.slice(2).join(" ") !== "version --prefer-online --json"
    )
      process.exit(99);
    if (packageAt("pending", commandArguments[1])) {
      if (Number.isFinite(options.timeout) && queryMilliseconds >= options.timeout) {
        elapsedMilliseconds += options.timeout;
        return {
          status: null,
          signal: options.killSignal,
          error: Object.assign(new Error("npm query ETIMEDOUT"), { code: "ETIMEDOUT" }),
        };
      }
      elapsedMilliseconds += queryMilliseconds;
    }
    if (visibility === "unreadable" && packageAt("pending", commandArguments[1])) {
      return { status: 1, stdout: JSON.stringify({ error: { code: "E503" } }) };
    }
    const directory = packageAt("published", commandArguments[1]);
    if (directory) {
      const manifest = JSON.parse(readFileSync(join(directory, "package/package.json"), "utf8"));
      return { status: 0, stdout: JSON.stringify(manifest.version) };
    }
    return { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) };
  }

  if (name === "npm" && commandArguments[0] === "publish") {
    const flags = commandArguments.slice(4);
    if (!flags[0]?.startsWith("--tag=")) {
      throw new Error("Release publication must pin an explicit npm distribution tag");
    }
    const channel = flags.shift().slice("--tag=".length);
    if (flags[0]?.startsWith("--otp=")) flags.shift();
    if (commandArguments[2] !== "--access" || commandArguments[3] !== "public" || flags.length)
      process.exit(99);
    const inspected = nativeSpawn("tar", ["-xOf", commandArguments[1], "package/package.json"], {
      encoding: "utf8",
    });
    if (inspected.error || inspected.status !== 0) return inspected;
    const manifest = JSON.parse(inspected.stdout);
    const directory = readdirSync(join(workspace, "packages")).find((candidate) => {
      const declaration = JSON.parse(
        readFileSync(join(workspace, "packages", candidate, "package.json"), "utf8"),
      );
      return declaration.name === manifest.name;
    });
    if (!directory) return { status: 1, stderr: "Unknown package identity" };
    if (directory === process.env.DOUGONG_RELEASE_PUBLISH_FAILURE) {
      return { status: 1, stderr: "Fixture publication failed" };
    }
    const reference = `${manifest.name}@${manifest.version}`;
    if (packageAt("published", reference) || packageAt("pending", reference)) {
      return { status: 1, stderr: "Package version is immutable" };
    }
    const target = join(workspace, visibility === "immediate" ? "published" : "pending", directory);
    mkdirSync(target, { recursive: true });
    const extracted = nativeSpawn("tar", ["-xzf", commandArguments[1], "-C", target], {
      stdio: "pipe",
    });
    if (extracted.status === 0) {
      const tags = registryTags();
      tags[manifest.name] = { ...tags[manifest.name], [channel]: manifest.version };
      writeFileSync(registryTagsPath, JSON.stringify(tags));
    }
    if (race === "registry-bytes" && extracted.status === 0)
      writeFileSync(join(target, "package/dist/index.js"), "export const replaced = true;");
    return extracted;
  }

  if (name === "npm" && commandArguments[0] === "whoami") return { status: 0, stdout: "fixture" };
  process.exit(99);
});
