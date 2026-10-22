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

installCommandFixture((name, args, options, nativeSpawn) => {
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
      const interrupt = recording && args[0] === process.env.DOUGONG_RELEASE_INTERRUPT;
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
    if (["status", "fetch"].includes(args[0]) || (args[0] === "tag" && args[1] === "--list")) {
      return { status: 0 };
    }
    process.exit(99);
  }

  if (name === "pnpm" && args.length === 1 && args[0] === "check") return { status: 0 };

  if (args[0] === "pack" && (name === "pnpm" || name === "npm")) {
    const stage = args[args.indexOf("--pack-destination") + 1];
    let source;
    if (name === "pnpm") {
      if (args.length !== 3 || args[1] !== "--pack-destination") process.exit(99);
      writeFileSync(join(workspace, "release-stage"), stage);
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
      const manifestPath = join(source, "package/package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (basename(options.cwd) === "core") {
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
    return nativeSpawn("tar", ["-xzf", args[1], "-C", target], { stdio: "pipe" });
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
