import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  candidateOutput,
  packCandidates,
  writeVerifiedCandidates,
} from "../../consumer/package-candidates.mjs";
import { installCommandFixture } from "../release-command-fixture.mjs";

const workspace = process.cwd();
const visibility = process.env.DOUGONG_RELEASE_VISIBILITY;
if (!["immediate", "delayed", "never", "unreadable"].includes(visibility)) {
  throw new TypeError(`Unknown fixture visibility: ${visibility}`);
}

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

let injected = false;
let previousPack;
installCommandFixture((name, args, options, nativeSpawn) => {
  const race = process.env.DOUGONG_RELEASE_CONCURRENT_EDIT;
  const git = process.env.DOUGONG_RELEASE_REAL_GIT;
  if (race && git && !injected) {
    const runGit = (...args) => {
      const result = nativeSpawn(git, args, { cwd: workspace, stdio: "pipe" });
      if (result.status !== 0) throw new Error("Concurrent Git fixture failed: " + result.stderr);
    };
    if (
      race === "build-before-pack" &&
      name === "pnpm" &&
      args[0] === "pack" &&
      basename(options.cwd) === "dougong"
    ) {
      writeFileSync(join(options.cwd, "dist/index.js"), "export const notTheTestedBuild = true;");
      injected = true;
    }
    if (name === "npm" && args[0] === "publish") {
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
      args[0] === "pack" &&
      basename(options.cwd) === "platform"
    ) {
      runGit("commit", "--allow-empty", "-m", "Concurrent commit during packing");
      injected = true;
    }
    if (race === "tag-head" && name === "git" && args[0] === "tag" && args.includes("-a")) {
      runGit("commit", "--allow-empty", "-m", "Concurrent commit before tag");
      injected = true;
    }
    if (race === "remote-tag-at-push" && name === "git" && args[0] === "push") {
      const tagRef = args.at(-1).split(":")[1];
      const original = nativeSpawn(git, ["rev-parse", "origin/main"], {
        cwd: workspace,
        encoding: "utf8",
      }).stdout.trim();
      runGit("-C", join(workspace, "remote.git"), "update-ref", tagRef, original);
      injected = true;
    }
    if (race === "push-refs" && name === "git" && args[0] === "push") {
      const tag =
        "v" + JSON.parse(readFileSync(join(workspace, "packages/dougong/package.json"))).version;
      runGit("commit", "--allow-empty", "-m", "Concurrent commit before push");
      runGit("tag", "-f", "-a", tag, "-m", "Unrelated local tag");
      injected = true;
    }
  }
  const recording =
    name === "git" &&
    (["add", "commit", "push"].includes(args[0]) || (args[0] === "tag" && args.includes("-a")));
  if (recording || name === "npm" || name === "sleep") {
    appendFileSync(
      join(workspace, "commands.jsonl"),
      JSON.stringify({ command: name, args }) + "\n",
    );
  }
  if (name === "git") {
    if (process.env.DOUGONG_RELEASE_REAL_GIT) {
      const interrupt =
        (recording || (args[0] === "diff" && args.includes("--cached"))) &&
        args[0] === process.env.DOUGONG_RELEASE_INTERRUPT;
      if (interrupt && process.env.DOUGONG_RELEASE_INTERRUPT_AFTER !== "true") {
        return { status: 1 };
      }
      const result = nativeSpawn(process.env.DOUGONG_RELEASE_REAL_GIT, args, {
        ...options,
        stdio: "pipe",
      });
      return { ...result, status: interrupt ? 1 : result.status };
    }
    if (args[0] === "rev-parse") {
      return { status: 0, stdout: args.includes("--abbrev-ref") ? "main" : "a".repeat(40) };
    }
    if (args[0] === "rev-list") return { status: 0, stdout: "0" };
    if (
      ["status", "fetch", "ls-remote"].includes(args[0]) ||
      (args[0] === "tag" && args[1] === "--list")
    ) {
      return { status: 0 };
    }
    process.exit(99);
  }

  if (name === "pnpm" && args.length === 1 && args[0] === "check") {
    appendFileSync(
      join(workspace, "commands.jsonl"),
      JSON.stringify({
        command: "gate-versions",
        args: ["reactive", "dougong", "platform"].map(
          (dir) =>
            JSON.parse(readFileSync(join(workspace, "packages", dir, "package.json"))).version,
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

  if (args[0] === "pack" && (name === "pnpm" || name === "npm")) {
    const stage = args[args.indexOf("--pack-destination") + 1];
    let source;
    if (name === "pnpm") {
      if (args.length !== 3 || args[1] !== "--pack-destination") process.exit(99);
      if (process.env.DOUGONG_RELEASE_REAL_PNPM) {
        return nativeSpawn(process.execPath, [process.env.DOUGONG_RELEASE_REAL_PNPM, ...args], {
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
      if (args.length !== 4 || args[2] !== "--pack-destination") process.exit(99);
      source = packageAt("published", args[1]);
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

  if (name === "npm" && args[0] === "view") {
    if (args.length !== 5 || args.slice(2).join(" ") !== "version --prefer-online --json")
      process.exit(99);
    if (visibility === "unreadable" && packageAt("pending", args[1])) {
      return { status: 1, stdout: JSON.stringify({ error: { code: "E503" } }) };
    }
    const directory = packageAt("published", args[1]);
    if (directory) {
      const manifest = JSON.parse(readFileSync(join(directory, "package/package.json"), "utf8"));
      return { status: 0, stdout: JSON.stringify(manifest.version) };
    }
    return { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) };
  }

  if (name === "npm" && args[0] === "publish") {
    if (
      args[2] !== "--access" ||
      args[3] !== "public" ||
      !(args.length === 4 || (args.length === 5 && args[4].startsWith("--otp=")))
    )
      process.exit(99);
    const inspected = nativeSpawn("tar", ["-xOf", args[1], "package/package.json"], {
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
    const extracted = nativeSpawn("tar", ["-xzf", args[1], "-C", target], { stdio: "pipe" });
    if (race === "registry-bytes" && extracted.status === 0)
      writeFileSync(join(target, "package/dist/index.js"), "export const replaced = true;");
    return extracted;
  }

  if (name === "sleep" && args.length === 1 && args[0] === "15") {
    if (visibility === "delayed") {
      const pending = join(workspace, "pending");
      mkdirSync(join(workspace, "published"), { recursive: true });
      for (const directory of readdirSync(pending)) {
        renameSync(join(pending, directory), join(workspace, "published", directory));
      }
    } else if (visibility !== "never") process.exit(99);
    return { status: 0 };
  }

  if (name === "npm" && args[0] === "whoami") return { status: 0, stdout: "fixture" };
  process.exit(99);
});
