import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";

// Recovery runs two CLIs, each bounded at ten seconds, plus real Git and archives.
vi.setConfig({ testTimeout: 30000 });
const executeFile = promisify(execFile);
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const release = fileURLToPath(new URL("../release.mjs", import.meta.url));
const version = "0.7.2";
const packages = ["reactive", "core", "platform", "dougong"];

const command = `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
const workspace = process.env.DOUGONG_RELEASE_FIXTURE;
if (name === "git") {
  const recording = ["add", "commit", "push"].includes(args[0]) || (args[0] === "tag" && args.includes("-a"));
  if (recording) {
    const path = join(workspace, "recorded.json");
    let calls = [];
    try { calls = JSON.parse(readFileSync(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    calls.push(args[0]);
    writeFileSync(path, JSON.stringify(calls));
  }
  if (process.env.DOUGONG_RELEASE_REAL_GIT) {
    const interrupt = recording && args[0] === process.env.DOUGONG_RELEASE_INTERRUPT;
    if (interrupt && process.env.DOUGONG_RELEASE_INTERRUPT_AFTER !== "true") process.exit(1);
    const result = spawnSync(process.env.DOUGONG_RELEASE_REAL_GIT, args, { stdio: "inherit" });
    process.exit(interrupt ? 1 : result.status ?? 99);
  }
  if (args[0] === "rev-parse") console.log(args.includes("--abbrev-ref") ? "main" : "a".repeat(40));
  else if (args[0] === "rev-list") console.log("0");
  else if (args[0] === "diff" && args.includes("--cached")) process.exit(1);
  else if (!recording && !["status", "fetch", "tag"].includes(args[0])) process.exit(99);
} else if (name === "mkdir") {
  mkdirSync(args[1], { recursive: true });
} else if (name === "pnpm" && args[0] === "check") {
  process.exit(0);
} else if (args[0] === "pack" && (name === "pnpm" || name === "npm")) {
  const stage = args[args.indexOf("--pack-destination") + 1];
  const packageName = name === "pnpm" ? basename(process.cwd()) : args[1].split("@").at(-2).split("/").at(-1);
  const source = join(workspace, name === "pnpm" ? "local" : "published", packageName);
  if (name === "pnpm") {
    cpSync(join(process.cwd(), "package.json"), join(source, "package/package.json"));
    if (packageName === "core") {
      const manifestPath = join(source, "package/package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (process.env.DOUGONG_RELEASE_PACKED_NAME) manifest.name = process.env.DOUGONG_RELEASE_PACKED_NAME;
      if (process.env.DOUGONG_RELEASE_PACKED_DEPENDENCIES) {
        manifest.dependencies = JSON.parse(process.env.DOUGONG_RELEASE_PACKED_DEPENDENCIES);
      }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\\n");
    }
    writeFileSync(join(workspace, "release-stage"), stage);
  }
  const archive = join(stage, packageName + ".tgz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", source, "package"]);
  if (packed.error || packed.status !== 0) process.exit(99);
  console.log(archive);
} else if (name === "npm" && args[0] === "view") {
  if (process.env.DOUGONG_RELEASE_ALL_PUBLISHED === "true" || args[1].startsWith("@dougongjs/reactive@")) console.log(JSON.stringify("${version}"));
  else {
    console.log(JSON.stringify({ error: { code: "E404" } }));
    process.exit(1);
  }
} else if (name === "npm" && args[0] === "whoami") console.log("fixture");
else process.exit(99);
`;

async function runRelease(
  mutate,
  {
    packedName = "",
    packedDependencies,
    declaredDependencies = { "@standard-schema/spec": "^1.0.0" },
    escapedNames = false,
    allPublished = false,
    dryRun = true,
    interruptAt,
    interruptAfter = false,
    resume = false,
    beforeResume = () => undefined,
  } = {},
) {
  const workspace = mkdtempSync(join(tmpdir(), "dougong-release-artifacts-test-"));
  const stages = new Set();
  try {
    const bin = join(workspace, "bin");
    mkdirSync(bin);
    for (const name of ["git", "npm", "pnpm", "mkdir"]) {
      writeFileSync(join(bin, name), command, { mode: 0o755 });
    }
    for (const name of ["tar", "gzip"]) {
      const executable = (process.env.PATH ?? "")
        .split(delimiter)
        .map((directory) => join(directory, name))
        .find((path) => existsSync(path));
      if (!executable) throw new Error(`Release fixture requires ${name}`);
      symlinkSync(executable, join(bin, name));
    }

    const originals = new Map();
    for (const name of packages) {
      const packageName = name === "dougong" ? name : `@dougongjs/${name}`;
      const manifest =
        `${JSON.stringify({ name: packageName, version: "0.7.1", ...(name === "core" ? { dependencies: declaredDependencies } : {}) }, null, 2)}\n`.replace(
          packageName,
          escapedNames ? packageName.replace("d", "\\u0064") : packageName,
        );
      const path = join(workspace, "packages", name, "package.json");
      mkdirSync(join(workspace, "packages", name), { recursive: true });
      writeFileSync(path, manifest);
      originals.set(path, manifest);
      const files = {
        "dist/index.js": "export const signal = value => value;\n",
        "dist/index.d.ts": 'export { signal } from "./signals";\n',
        "dist/signals.d.ts": "export declare function signal(value: number): number;\n",
        "dist/index.d.ts.map": '{"version":3,"sources":["../src/index.ts"]}',
        "dist/payload.bin": Buffer.from([0xff, 0x00, 0x01]),
        "README.md": "Fixture documentation\n",
        LICENSE: "Fixture license\n",
        "package.json": `${JSON.stringify({ name: packageName, version, ...(name === "core" ? { dependencies: declaredDependencies } : {}) }, null, 2)}\n`,
      };
      for (const side of ["local", "published"]) {
        const root = join(workspace, side, name, "package");
        for (const [file, contents] of Object.entries(files)) {
          mkdirSync(dirname(join(root, file)), { recursive: true });
          writeFileSync(join(root, file), contents);
        }
      }
    }
    mutate(join(workspace, "published/reactive/package"));
    const realGit = interruptAt
      ? (process.env.PATH ?? "")
          .split(delimiter)
          .map((directory) => join(directory, "git"))
          .find((path) => existsSync(path))
      : undefined;
    const git = (args, cwd = workspace) =>
      execFileSync(realGit, args, {
        cwd,
        env: environment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    if (interruptAt) {
      if (!realGit) throw new Error("Release recording fixture requires git");
      git(["init", "--bare", join(workspace, "remote.git")]);
      git(["init", "-b", "main"]);
      git(["config", "user.name", "Release fixture"]);
      git(["config", "user.email", "release@example.test"]);
      git(["config", "commit.gpgsign", "false"]);
      git(["config", "tag.gpgsign", "false"]);
      git(["add", "packages"]);
      git(["commit", "-m", "Initial packages"]);
      git(["remote", "add", "origin", join(workspace, "remote.git")]);
      git(["push", "origin", "main"]);
      writeFileSync(
        join(workspace, ".git/info/exclude"),
        [
          "/bin/",
          "/local/",
          "/published/",
          "/remote.git/",
          "/recorded.json",
          "/release-stage",
          "",
        ].join("\n"),
      );
    }
    const execute = async (interruption) => {
      try {
        const { stdout, stderr } = await executeFile(
          process.execPath,
          [release, version, dryRun ? "--dry-run" : "--yes"],
          {
            cwd: workspace,
            env: {
              ...environment,
              PATH: bin,
              DOUGONG_RELEASE_FIXTURE: workspace,
              DOUGONG_RELEASE_ALL_PUBLISHED: String(allPublished),
              DOUGONG_RELEASE_PACKED_NAME: packedName,
              DOUGONG_RELEASE_PACKED_DEPENDENCIES:
                packedDependencies === undefined ? "" : JSON.stringify(packedDependencies),
              DOUGONG_RELEASE_REAL_GIT: realGit ?? "",
              DOUGONG_RELEASE_INTERRUPT: interruption ?? "",
              DOUGONG_RELEASE_INTERRUPT_AFTER: String(interruptAfter),
            },
            encoding: "utf8",
            timeout: 10000,
          },
        );
        return { status: 0, stdout, stderr };
      } catch (error) {
        if (typeof error.code !== "number") throw error;
        return { status: error.code, stdout: error.stdout, stderr: error.stderr };
      } finally {
        const stageRecord = join(workspace, "release-stage");
        if (existsSync(stageRecord)) stages.add(readFileSync(stageRecord, "utf8"));
      }
    };
    const interrupted = await execute(interruptAt);
    const interruptedState = interruptAt
      ? {
          status: git(["status", "--porcelain"]),
          versions: packages.map(
            (name) =>
              JSON.parse(readFileSync(join(workspace, "packages", name, "package.json"), "utf8"))
                .version,
          ),
          ahead: git(["rev-list", "--count", "origin/main..HEAD"]),
          tag: git(["tag", "--list", `v${version}`]),
        }
      : undefined;
    if (resume) beforeResume(git, workspace);
    const result = resume ? await execute(undefined) : interrupted;
    for (const [path, contents] of originals) {
      const expected =
        dryRun || (!resume && result.status !== 0)
          ? contents
          : `${JSON.stringify({ ...JSON.parse(contents), version }, null, 2)}\n`;
      expect(readFileSync(path, "utf8")).toBe(expected);
    }
    const recorded = join(workspace, "recorded.json");
    return {
      ...result,
      interrupted,
      interruptedState,
      recorded: existsSync(recorded) ? JSON.parse(readFileSync(recorded, "utf8")) : [],
      remoteRefs: interruptAt
        ? git(["ls-remote", "origin", "refs/heads/main", `refs/tags/v${version}^{}`])
        : undefined,
      remoteTags: interruptAt ? git(["ls-remote", "--tags", "origin"]) : undefined,
      head: interruptAt ? git(["rev-parse", "HEAD"]) : undefined,
    };
  } finally {
    for (const stage of stages) rmSync(stage, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

it.each([
  ["dist/signals.d.ts", "export declare function signal(value: string): string;\n"],
  ["dist/index.d.ts.map", '{"version":3,"sources":["../src/previous.ts"]}'],
  ["dist/payload.bin", Buffer.from([0xfe, 0x00, 0x01])],
  ["README.md", "Previous documentation\n"],
  ["LICENSE", "Previous license\n"],
])("refuses to resume a published version with different %s", async (file, contents) => {
  const result = await runRelease((root) => writeFileSync(join(root, file), contents));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(file);
  expect(result.stdout).not.toContain("contents match");
});

it.each([false, true])(
  "does not publish unrelated local tags (push.followTags: %s)",
  async (followTags) => {
    const result = await runRelease(() => undefined, {
      allPublished: true,
      dryRun: false,
      interruptAt: "push",
      resume: true,
      beforeResume(git) {
        git(["config", "push.followTags", String(followTags)]);
        git(["tag", "-a", "unrelated", "-m", "Another operation owns this tag"]);
      },
    });
    expect(result.status).toBe(0);
    expect(result.remoteTags).toContain(`refs/tags/v${version}`);
    expect(result.remoteTags).not.toContain("unrelated");
  },
);

it("refuses untracked source even when Git hides it by default", async () => {
  const result = await runRelease(() => undefined, {
    allPublished: true,
    dryRun: false,
    interruptAt: "push",
    resume: true,
    beforeResume(git, workspace) {
      git(["config", "status.showUntrackedFiles", "no"]);
      writeFileSync(join(workspace, "source.js"), "export const unpublished = true;\n");
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("working tree is not clean");
  expect(result.stdout).not.toContain("Running the full gate");
});

it.each(["another commit", "source in the release commit"])(
  "refuses recovery with %s outside the release manifests",
  async (kind) => {
    const result = await runRelease(() => undefined, {
      allPublished: true,
      dryRun: false,
      interruptAt: "tag",
      resume: true,
      beforeResume(git, workspace) {
        writeFileSync(join(workspace, "source.js"), "export const unrelated = true;\n");
        git(["add", "source.js"]);
        git(
          kind === "another commit"
            ? ["commit", "-m", "Another change"]
            : ["commit", "--amend", "--no-edit"],
        );
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ahead of origin/main");
    expect(result.stdout).not.toContain("Running the full gate");
  },
);

it.each(["lightweight", "another commit"])("refuses a release tag pointing to %s", async (kind) => {
  const result = await runRelease(() => undefined, {
    allPublished: true,
    dryRun: false,
    interruptAt: "push",
    resume: true,
    beforeResume(git) {
      git(["tag", "-d", `v${version}`]);
      git(
        kind === "lightweight"
          ? ["tag", `v${version}`]
          : ["tag", "-a", `v${version}`, "origin/main", "-m", "Wrong release"],
      );
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("does not record this release");
  expect(result.stdout).not.toContain("Running the full gate");
});

it("preserves remote main when the remote release tag conflicts", async () => {
  const result = await runRelease(() => undefined, {
    allPublished: true,
    dryRun: false,
    interruptAt: "push",
    resume: true,
    beforeResume(git, workspace) {
      git(
        ["update-ref", `refs/tags/v${version}`, git(["rev-parse", "origin/main"])],
        join(workspace, "remote.git"),
      );
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("atomic push failed");
  expect(result.remoteRefs).not.toContain(result.head);
});

it.each(["missing", "additional"])("refuses to resume when a package file is %s", async (kind) => {
  const file = kind === "missing" ? "dist/signals.d.ts" : "dist/previous.d.ts";
  const result = await runRelease((root) => {
    if (kind === "missing") rmSync(join(root, file));
    else writeFileSync(join(root, file), "Previous public declaration\n");
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(file);
  expect(result.stdout).not.toContain("contents match");
});

it("resumes packaging only when the complete published package matches", async () => {
  const result = await runRelease(() => undefined);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("already published, contents match");
  expect(result.stdout).toContain("Dry run complete");
});

it("finishes release recording after every upload already completed", async () => {
  const result = await runRelease(() => undefined, { allPublished: true, dryRun: false });
  expect(result.status).toBe(0);
  expect(result.recorded).toEqual(["add", "commit", "tag", "push"]);
  expect(result.stdout.match(/already published, contents match/g)).toHaveLength(packages.length);
  expect(result.stdout).toContain("released");
});

it.each([
  { command: "add", after: true, committed: false },
  { command: "commit", after: false, committed: false },
  { command: "commit", after: true, committed: true },
  { command: "tag", after: false, committed: true },
  { command: "tag", after: true, committed: true },
  { command: "push", after: false, committed: true },
  { command: "push", after: true, committed: true },
])(
  "resumes release recording after $command fails (after command: $after)",
  async ({ command, after, committed }) => {
    const result = await runRelease(() => undefined, {
      allPublished: true,
      dryRun: false,
      interruptAt: command,
      interruptAfter: after,
      resume: true,
    });
    expect(result.interrupted.status).toBe(1);
    expect(result.interruptedState.status).toBe("");
    expect(result.interruptedState.versions).toEqual(
      packages.map(() => (committed ? version : "0.7.1")),
    );
    expect(result.interruptedState.ahead).toBe(
      committed && !(command === "push" && after) ? "1" : "0",
    );
    expect(result.interruptedState.tag).toBe(
      command === "push" || (command === "tag" && after) ? `v${version}` : "",
    );
    expect(result.status).toBe(0);
    expect(result.remoteRefs.split("\n")).toEqual([
      `${result.head}\trefs/heads/main`,
      `${result.head}\trefs/tags/v${version}^{}`,
    ]);
  },
);

it("refuses fully published recovery when the final package differs", async () => {
  const result = await runRelease(
    (root) =>
      writeFileSync(
        join(dirname(dirname(root)), "dougong/package/README.md"),
        "Different documentation\n",
      ),
    { allPublished: true, dryRun: false },
  );
  expect(result.status).toBe(1);
  expect(result.recorded).toEqual([]);
  expect(result.stderr).toContain("README.md differs");
});

it("restores the original manifest bytes after a successful dry run", async () => {
  const result = await runRelease(() => undefined, { escapedNames: true });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("package.json versions restored");
});

it("rejects a tarball carrying another package's identity before publication", async () => {
  const result = await runRelease(() => undefined, { packedName: "@fixture/unexpected" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("tarball declares name @fixture/unexpected");
  expect(result.stdout).not.toContain("Dry run complete");
});

it.each([
  { range: version, status: 0, output: "stdout", message: "Dry run complete" },
  { range: "^0.7.20", status: 1, output: "stderr", message: `expected ${version}` },
])(
  "checks the packed internal dependency version $range",
  async ({ range, status, output, message }) => {
    const result = await runRelease(() => undefined, {
      declaredDependencies: { "@dougongjs/reactive": "workspace:*" },
      packedDependencies: { "@dougongjs/reactive": range },
    });
    expect(result.status).toBe(status);
    expect(result[output]).toContain(message);
  },
);

it.each([
  { dependencies: {}, message: "@standard-schema/spec", label: "a missing dependency" },
  {
    dependencies: { "@standard-schema/spec": "^2.0.0" },
    message: "expected ^1.0.0",
    label: "a changed external dependency range",
  },
  {
    dependencies: { "@standard-schema/spec": "^1.0.0", "@fixture/unexpected": "^1.0.0" },
    message: "@fixture/unexpected",
    label: "an undeclared dependency",
  },
])("rejects a tarball with $label", async ({ dependencies, message }) => {
  const result = await runRelease(() => undefined, { packedDependencies: dependencies });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stdout).not.toContain("Dry run complete");
});
