import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { executeRelease, releaseTestTimeout } from "./release-fixture.mjs";

vi.setConfig({ testTimeout: releaseTestTimeout });
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const release = fileURLToPath(new URL("../release/release.mjs", import.meta.url));
const version = "0.7.2";
const packages = ["reactive", "dougong", "platform"];

const preload = fileURLToPath(new URL("./fixtures/release-artifacts.mjs", import.meta.url));

function requireExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(directory, name);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error;
    }
  }
  throw new Error(`Release fixture requires ${name}`);
}

async function runRelease(
  mutate,
  {
    version: targetVersion = version,
    distributionTag,
    registries = {},
    packedOverrides = {},
    declaredDependencies = { "@standard-schema/spec": "^1.0.0" },
    escapedNames = false,
    publishedPackages = ["reactive"],
    publishedArchivePrefix = "",
    dryRun = true,
    realPack = false,
    publishFailure,
    concurrentEdit,
    visibility = "immediate",
    oneTimePassword,
    interruptAt,
    interruptAfter = false,
    resume = false,
    beforeRelease = () => undefined,
    beforeResume = () => undefined,
    afterRelease = () => undefined,
  } = {},
) {
  const workspace = mkdtempSync(join(tmpdir(), "dougong-release-artifacts-test-"));
  const stages = new Set();
  try {
    const executableDirectory = join(workspace, "bin");
    mkdirSync(executableDirectory);
    for (const name of ["tar", "gzip"]) {
      symlinkSync(requireExecutable(name), join(executableDirectory, name));
    }
    if (realPack) {
      // Package-manager launchers need their own runtime without gaining the caller's whole PATH.
      symlinkSync(process.execPath, join(executableDirectory, "node"));
      for (const name of ["dirname", "readlink", "sed", "uname"]) {
        symlinkSync(requireExecutable(name), join(executableDirectory, name));
      }
    }

    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({
        private: true,
        packageManager: JSON.parse(
          readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
        ).packageManager,
      }),
    );
    writeFileSync(join(workspace, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    for (const name of packages) {
      const packageName = name === "dougong" ? name : `@dougongjs/${name}`;
      const manifest = `${JSON.stringify(
        {
          name: packageName,
          type: "module",
          files: ["dist", "README.md", "LICENSE"],
          version: "0.7.1",
          exports: {
            ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
            ...(name === "dougong"
              ? { "./advanced": { types: "./dist/advanced.d.ts", import: "./dist/advanced.js" } }
              : {}),
          },
          ...(name === "dougong" ? { dependencies: declaredDependencies } : {}),
        },
        null,
        2,
      )}\n`.replace(packageName, escapedNames ? packageName.replace("d", "\\u0064") : packageName);
      const path = join(workspace, "packages", name, "package.json");
      mkdirSync(join(workspace, "packages", name), { recursive: true });
      writeFileSync(path, manifest);
      const files = {
        ...(name === "dougong"
          ? { "dist/advanced.d.ts": "export {};\n", "dist/advanced.js": "export {};\n" }
          : {}),
        "dist/index.js": "export const signal = value => value;\n",
        "dist/index.d.ts": 'export { signal } from "./signals";\n',
        "dist/signals.d.ts": "export declare function signal(value: number): number;\n",
        "dist/index.d.ts.map": '{"version":3,"sources":["../src/index.ts"]}',
        "dist/payload.bin": Buffer.from([0xff, 0x00, 0x01]),
        "README.md": "Fixture documentation\n",
        LICENSE: "Fixture license\n",
      };
      for (const side of ["packages", "published"]) {
        if (side === "published" && !publishedPackages.includes(name)) continue;
        const root = join(workspace, side, name, ...(side === "published" ? ["package"] : []));
        for (const [file, contents] of Object.entries(files)) {
          mkdirSync(dirname(join(root, file)), { recursive: true });
          writeFileSync(join(root, file), contents);
        }
        if (side === "published") {
          writeFileSync(
            join(root, "package.json"),
            JSON.stringify({ ...JSON.parse(manifest), version: targetVersion }, null, 2),
          );
        }
      }
    }
    mutate(join(workspace, "published/reactive/package"), workspace);
    const originals = new Map(
      packages.map((name) => {
        const path = join(workspace, "packages", name, "package.json");
        return [path, readFileSync(path, "utf8")];
      }),
    );
    const realGit = dryRun ? undefined : requireExecutable("git");
    const git = (commandArguments, workingDirectory = workspace) =>
      execFileSync(realGit, commandArguments, {
        cwd: workingDirectory,
        env: environment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    let initialHead;
    if (!dryRun) {
      git(["init", "--bare", join(workspace, "remote.git")]);
      git(["init", "-b", "main"]);
      git(["config", "user.name", "Release fixture"]);
      git(["config", "user.email", "release@example.test"]);
      git(["config", "commit.gpgsign", "false"]);
      git(["config", "tag.gpgsign", "false"]);
      git(["add", "packages"]);
      git(["commit", "-m", "Initial packages"]);
      initialHead = git(["rev-parse", "HEAD"]);
      git(["remote", "add", "origin", join(workspace, "remote.git")]);
      git(["push", "origin", "main"]);
      writeFileSync(
        join(workspace, ".git/info/exclude"),
        [
          "/bin/",
          "/published/",
          "/pending/",
          "/remote.git/",
          "/commands.jsonl",
          "/dist-tags.json",
          "/release-stage",
          "/package.json",
          "/pnpm-workspace.yaml",
          "",
        ].join("\n"),
      );
    }
    const pnpm = realPack ? requireExecutable("pnpm") : undefined;
    const execute = async (interruption, publicationFailure) => {
      try {
        return await executeRelease(
          [
            "--import",
            preload,
            release,
            targetVersion,
            ...(distributionTag === undefined ? [] : [`--tag=${distributionTag}`]),
            dryRun ? "--dry-run" : "--yes",
            ...(oneTimePassword ? [`--otp=${oneTimePassword}`] : []),
          ],
          {
            cwd: workspace,
            env: {
              ...environment,
              PATH: executableDirectory,
              DOUGONG_RELEASE_REGISTRIES: JSON.stringify(registries),
              DOUGONG_RELEASE_PACKED_OVERRIDES: JSON.stringify(packedOverrides),
              DOUGONG_RELEASE_REAL_GIT: realGit ?? "",
              DOUGONG_RELEASE_REAL_PNPM: pnpm ?? "",
              DOUGONG_RELEASE_PUBLISH_FAILURE: publicationFailure ?? "",
              DOUGONG_RELEASE_CONCURRENT_EDIT: concurrentEdit ?? "",
              DOUGONG_RELEASE_VISIBILITY: visibility,
              DOUGONG_RELEASE_PUBLISHED_ARCHIVE_PREFIX: publishedArchivePrefix,
              DOUGONG_RELEASE_INTERRUPT: interruption ?? "",
              DOUGONG_RELEASE_INTERRUPT_AFTER: String(interruptAfter),
            },
          },
        );
      } finally {
        const stageRecord = join(workspace, "release-stage");
        if (existsSync(stageRecord)) stages.add(readFileSync(stageRecord, "utf8"));
      }
    };
    const publishedManifests = () =>
      Object.fromEntries(
        packages.flatMap((name) => {
          const path = join(workspace, "published", name, "package/package.json");
          return existsSync(path) ? [[name, JSON.parse(readFileSync(path, "utf8"))]] : [];
        }),
      );
    beforeRelease(git, workspace);
    const interrupted = await execute(interruptAt, publishFailure);
    const publishedAfterFirstAttempt = publishedManifests();
    const interruptedState = interruptAt
      ? {
          status: git(["status", "--porcelain"]),
          versions: packages.map(
            (name) =>
              JSON.parse(readFileSync(join(workspace, "packages", name, "package.json"), "utf8"))
                .version,
          ),
          ahead: git(["rev-list", "--count", "origin/main..HEAD"]),
          tag: git(["tag", "--list", `v${targetVersion}`]),
        }
      : undefined;
    if (resume) beforeResume(git, workspace);
    const result = resume ? await execute(undefined) : interrupted;
    afterRelease(git, workspace);
    const head = realGit ? git(["rev-parse", "HEAD"]) : undefined;
    for (const [path, contents] of originals) {
      const edited =
        concurrentEdit === "manifest" && path === join(workspace, "packages/dougong/package.json");
      const expected =
        edited || (realGit && head !== initialHead)
          ? JSON.stringify(
              {
                ...JSON.parse(contents),
                version: targetVersion,
                ...(edited ? { description: "Concurrent manifest edit" } : {}),
              },
              null,
              2,
            ) + "\n"
          : contents;
      expect(readFileSync(path, "utf8")).toBe(expected);
    }
    const commands = join(workspace, "commands.jsonl");
    const calls = existsSync(commands)
      ? readFileSync(commands, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    return {
      ...result,
      interrupted,
      interruptedState,
      publishedAfterFirstAttempt,
      publishedCoreModule: existsSync(join(workspace, "published/dougong/package/dist/index.js"))
        ? readFileSync(join(workspace, "published/dougong/package/dist/index.js"), "utf8")
        : undefined,
      published: publishedManifests(),
      calls,
      recorded: calls
        .filter(({ command }) => command === "git")
        .map(({ commandArguments }) => commandArguments[0]),
      stagedFiles: realGit ? git(["diff", "--cached", "--name-only"]) : undefined,
      committedFiles: realGit ? git(["diff", "--name-only", initialHead, "HEAD"]) : undefined,
      parent: realGit && head !== initialHead ? git(["rev-parse", "HEAD^"]) : undefined,
      initialHead,
      remoteReferences: realGit
        ? git(["ls-remote", "origin", "refs/heads/main", `refs/tags/v${targetVersion}^{}`])
        : undefined,
      remoteTags: realGit ? git(["ls-remote", "--tags", "origin"]) : undefined,
      head,
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
      publishedPackages: packages,
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
    publishedPackages: packages,
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
      publishedPackages: packages,
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
    publishedPackages: packages,
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

it("rejects an existing remote tag before uploading an irreversible npm version", async () => {
  const result = await runRelease(() => undefined, {
    publishedPackages: [],
    dryRun: false,
    beforeRelease(git, workspace) {
      git(["config", "remote.origin.tagOpt", "--no-tags"]);
      git(
        ["update-ref", `refs/tags/v${version}`, git(["rev-parse", "HEAD"])],
        join(workspace, "remote.git"),
      );
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("origin already has a different release tag");
  expect(result.published).toEqual({});
  expect(result.recorded).toEqual([]);
});

it.each(["reserved tag", "multiple destinations"])(
  "checks the configured Git push destination before npm publication (%s)",
  async (conflict) => {
    const result = await runRelease(() => undefined, {
      dryRun: false,
      publishedPackages: [],
      beforeRelease(git, workspace) {
        const origin = join(workspace, "remote.git");
        const destination = join(origin, "publish.git");
        git(["clone", "--bare", origin, destination]);
        git(["remote", "set-url", "--push", "origin", destination]);
        if (conflict === "reserved tag")
          git(["-C", destination, "update-ref", `refs/tags/v${version}`, "refs/heads/main"]);
        else git(["remote", "set-url", "--add", "--push", "origin", origin]);
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      conflict === "reserved tag" ? "different release tag" : "one push destination",
    );
    expect(result.published).toEqual({});
    expect(result.recorded).toEqual([]);
  },
);

it.each([
  { rewrite: "pushInsteadOf", rejected: false },
  { rewrite: "insteadOf", rejected: true },
])(
  "keeps release destination ownership across a second $rewrite rewrite",
  async ({ rewrite, rejected }) => {
    let references;
    const result = await runRelease(() => undefined, {
      dryRun: false,
      publishedPackages: [],
      beforeRelease(git, workspace) {
        const origin = join(workspace, "remote.git");
        const destination = join(origin, "publish.git");
        const unrelated = join(origin, "unrelated.git");
        git(["clone", "--bare", origin, destination]);
        git(["clone", "--bare", origin, unrelated]);
        git(["config", `url.${destination}.pushInsteadOf`, origin]);
        git(["config", `url.${unrelated}.${rewrite}`, destination]);
        git(["remote", "add", "dougong-release", unrelated]);
      },
      afterRelease(git, workspace) {
        const origin = join(workspace, "remote.git");
        references = {
          destination: git(["rev-parse", "refs/heads/main"], join(origin, "publish.git")),
          unrelated: git(["rev-parse", "refs/heads/main"], join(origin, "unrelated.git")),
          destinationTag: git(["tag", "--list", `v${version}`], join(origin, "publish.git")),
          unrelatedTag: git(["tag", "--list", `v${version}`], join(origin, "unrelated.git")),
          remotes: git(["remote"]),
          originPush: git(["remote", "get-url", "--push", "origin"]),
          preserved: git(["remote", "get-url", "dougong-release"]),
          destinationPath: join(origin, "publish.git"),
          unrelatedPath: join(origin, "unrelated.git"),
        };
      },
    });
    expect(result.status).toBe(rejected ? 1 : 0);
    expect(Object.keys(result.published)).toEqual(rejected ? [] : packages);
    expect(result.recorded).toEqual(rejected ? [] : ["commit", "tag", "push"]);
    expect(result.stderr.includes("release destination would be rewritten")).toBe(rejected);
    expect(references.destination).toBe(rejected ? result.initialHead : result.head);
    expect(references.destinationTag).toBe(rejected ? "" : `v${version}`);
    expect(references.unrelated).toBe(result.initialHead);
    expect(references.unrelatedTag).toBe("");
    expect(references.remotes).toBe("dougong-release\norigin");
    expect(references.originPush).toBe(references.destinationPath);
    expect(references.preserved).toBe(references.unrelatedPath);
  },
);

it("preserves remote main when the remote release tag changes after preflight", async () => {
  const result = await runRelease(() => undefined, {
    publishedPackages: packages,
    dryRun: false,
    concurrentEdit: "remote-tag-at-push",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("atomic push failed");
  expect(result.remoteReferences).not.toContain(result.head);
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

it.each([undefined, "123456"])(
  "publishes inspected tarballs and confirms every upload before recording the release (OTP: %s)",
  async (oneTimePassword) => {
    const result = await runRelease(() => undefined, { dryRun: false, oneTimePassword });
    expect(result.status).toBe(0);
    expect(Object.keys(result.published)).toEqual(packages);
    expect(Object.values(result.published).map((manifest) => manifest.version)).toEqual(
      packages.map(() => version),
    );
    const publication = result.calls.filter(
      ({ command, commandArguments }) =>
        command === "npm" && ["publish", "view"].includes(commandArguments[0]),
    );
    expect(publication.map(({ commandArguments }) => commandArguments[0])).toEqual([
      ...packages.map(() => "view"),
      ...packages.slice(1).flatMap(() => ["publish", "view"]),
    ]);
    for (const { commandArguments } of publication.filter(
      ({ commandArguments }) => commandArguments[0] === "publish",
    )) {
      expect(commandArguments.slice(2)).toEqual([
        "--access",
        "public",
        ...(oneTimePassword ? [`--otp=${oneTimePassword}`] : []),
      ]);
      expect(commandArguments[1]).toMatch(/\.tgz$/);
    }
    expect(result.calls.slice(-3).map(({ command }) => command)).toEqual(["git", "git", "git"]);
    expect(result.recorded).toEqual(["commit", "tag", "push"]);
    expect(result.remoteReferences.split("\n")).toEqual([
      `${result.head}\trefs/heads/main`,
      `${result.head}\trefs/tags/v${version}^{}`,
    ]);
  },
);

it.each(["immediate", "delayed"])(
  "publishes every package for an unused registry version (%s)",
  async (visibility) => {
    const result = await runRelease(() => undefined, {
      publishedPackages: [],
      dryRun: false,
      visibility,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${version} is unused on the registry`);
    expect(Object.keys(result.published)).toEqual(packages);
    const uploads = result.calls.filter(
      ({ command, commandArguments }) => command === "npm" && commandArguments[0] === "publish",
    );
    expect(uploads.map(({ commandArguments }) => commandArguments[1].split("/").at(-1))).toEqual(
      packages.map((name) => `${name}.tgz`),
    );
    expect(result.recorded).toEqual(["commit", "tag", "push"]);
    expect(result.remoteReferences.split("\n")).toEqual([
      `${result.head}\trefs/heads/main`,
      `${result.head}\trefs/tags/v${version}^{}`,
    ]);
  },
);

it.each(["complete", "excluded dist", "directory README.md"])(
  "inspects packages produced by the actual pnpm pack command (%s)",
  async (contents) => {
    const result = await runRelease(
      (_published, workspace) => {
        const dependency = join(workspace, "packages/dougong/node_modules/@dougongjs/reactive");
        mkdirSync(dirname(dependency), { recursive: true });
        symlinkSync(join(workspace, "packages/reactive"), dependency);
        if (contents === "complete") return;
        if (contents === "directory README.md") {
          const path = join(workspace, "packages/dougong/README.md");
          rmSync(path);
          mkdirSync(path);
          writeFileSync(join(path, "notice.txt"), "Not the required file\n");
          return;
        }
        const path = join(workspace, "packages/dougong/package.json");
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.files = ["README.md", "LICENSE"];
        writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
      },
      {
        realPack: true,
        declaredDependencies: { "@dougongjs/reactive": "workspace:*" },
      },
    );
    expect({ status: result.status, error: contents === "complete" ? result.stderr : "" }).toEqual({
      status: contents === "complete" ? 0 : 1,
      error: "",
    });
    expect(result[contents === "complete" ? "stdout" : "stderr"]).toContain(
      contents === "complete"
        ? "Dry run complete"
        : `tarball is missing ${contents === "excluded dist" ? "dist/index.js" : "README.md"}`,
    );
  },
);

it("packs through a shell executable without restoring the caller's command path", async () => {
  const pnpm = requireExecutable("pnpm");
  const directory = mkdtempSync(join(tmpdir(), "dougong pnpm launcher-"));
  try {
    writeFileSync(
      join(directory, "pnpm"),
      `#!/bin/sh
if command -v npm >/dev/null 2>&1; then
  echo "The real npm command escaped fixture isolation" >&2
  exit 1
fi
exec '${pnpm.replaceAll("'", "'\"'\"'")}' "$@"
`,
      { mode: constants.S_IRUSR | constants.S_IWUSR | constants.S_IXUSR },
    );
    const shadow = join(directory, "shadow");
    mkdirSync(shadow);
    writeFileSync(join(shadow, "pnpm"), "not executable", { mode: 0o644 });
    mkdirSync(join(shadow, "tar"));
    vi.stubEnv("PATH", [shadow, directory, process.env.PATH].join(delimiter));
    const result = await runRelease(() => undefined, { realPack: true });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(result.stdout).toContain("Dry run complete");
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE"])(
  "rejects a candidate missing %s",
  async (file) => {
    const result = await runRelease((_published, workspace) => {
      rmSync(join(workspace, "packages/dougong", file));
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`missing ${file}`);
    expect(result.recorded).toEqual([]);
  },
);

it.each(["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE"])(
  "rejects a directory in place of the required file %s",
  async (file) => {
    const result = await runRelease((_published, workspace) => {
      const path = join(workspace, "packages/dougong", file);
      rmSync(path);
      mkdirSync(path);
      writeFileSync(join(path, "notice.txt"), "Not the required file\n");
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`tarball is missing ${file}`);
    expect(result.recorded).toEqual([]);
  },
);

it("refuses publication when a manifest names a missing runtime asset", async () => {
  const result = await runRelease(
    (_published, workspace) => {
      const path = join(workspace, "packages/dougong/package.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.files.push("runtime/adapter.wasm");
      writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
    },
    { publishedPackages: [], dryRun: false },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("missing runtime/adapter.wasm");
  expect(result.published).toEqual({});
  expect(result.recorded).toEqual([]);
});

it("rejects non-regular candidate entries before first publication", async () => {
  const result = await runRelease((_published, workspace) => {
    symlinkSync("index.d.ts", join(workspace, "packages/dougong/dist/linked.d.ts"));
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Package entry 'dist/linked.d.ts' must be a regular file");
  expect(result.recorded).toEqual([]);
});

it("rejects published hard links even when extracted bytes match the candidate", async () => {
  const result = await runRelease((root, workspace) => {
    const target = join(root, "dist/index.js");
    linkSync(target, join(root, "dist/linked.js"));
    writeFileSync(join(workspace, "packages/reactive/dist/linked.js"), readFileSync(target));
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("must be a regular file");
  expect(result.stdout).not.toContain("contents match");
  expect(result.recorded).toEqual([]);
});

it.each(["candidate", "published"])(
  "rejects a symbolic %s package root instead of reading outside the archive",
  async (side) => {
    const result = await runRelease((published, workspace) => {
      const root = side === "candidate" ? join(workspace, "packages/dougong") : published;
      const external = join(workspace, "outside-archive");
      renameSync(root, external);
      symlinkSync(external, root);
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Package root must be a directory");
    expect(result.stdout).not.toContain("Dry run complete");
    expect(result.recorded).toEqual([]);
  },
);

it.each(["outside.txt", "other/dist/index.js"])(
  "rejects the uninspected archive entry %s outside package",
  async (file) => {
    const result = await runRelease((root) => {
      const path = join(dirname(root), file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "export const different = true;\n");
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Package archive must contain only the package directory");
    expect(result.stdout).not.toContain("contents match");
    expect(result.recorded).toEqual([]);
  },
);

it("rejects archive member roots that extraction would normalize", async () => {
  const result = await runRelease(() => undefined, { publishedArchivePrefix: "./" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Package archive must contain only the package directory");
  expect(result.stdout).not.toContain("contents match");
  expect(result.recorded).toEqual([]);
});

it.each(
  ["dist/index.js", "dist/index.d.ts"].flatMap((file) =>
    ["@dougong/", "/Users/", "workspace:", "src/index.ts"].map((reference) => ({
      file,
      reference,
    })),
  ),
)("rejects nonportable reference $reference in $file", async ({ file, reference }) => {
  const result = await runRelease((_published, workspace) => {
    writeFileSync(join(workspace, "packages/dougong", file), `export * from "${reference}";\n`);
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${file} contains '${reference}'`);
  expect(result.stdout).not.toContain("Dry run complete");
  expect(result.recorded).toEqual([]);
});

it.each([false, true])(
  "preserves partial publication and resumes from registry contents (resume: %s)",
  async (resume) => {
    const result = await runRelease(() => undefined, {
      dryRun: false,
      publishFailure: "platform",
      resume,
    });
    expect(result.interrupted.status).toBe(1);
    expect(result.interrupted.stderr).toContain("@dougongjs/platform failed to publish");
    expect(Object.keys(result.publishedAfterFirstAttempt)).toEqual(["reactive", "dougong"]);
    const uploads = result.calls.filter(
      ({ command, commandArguments }) => command === "npm" && commandArguments[0] === "publish",
    );
    expect(uploads.map(({ commandArguments }) => commandArguments[1].split("/").at(-1))).toEqual(
      resume ? ["dougong.tgz", "platform.tgz", "platform.tgz"] : ["dougong.tgz", "platform.tgz"],
    );
    expect(result.status).toBe(resume ? 0 : 1);
    expect(result.recorded).toEqual(resume ? ["commit", "tag", "push"] : []);
    expect(Object.keys(result.published)).toEqual(resume ? packages : ["reactive", "dougong"]);
  },
);

it.each(["command", "manifest"])(
  "publishes and resumes a prerelease with its %s dist-tag",
  async (source) => {
    const version = "0.7.2-alpha.1";
    const result = await runRelease(
      (_published, workspace) => {
        for (const name of packages) {
          const path = join(workspace, "packages", name, "package.json");
          const manifest = JSON.parse(readFileSync(path));
          manifest.publishConfig = { tag: "canary" };
          writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
        }
      },
      {
        version,
        distributionTag: source === "command" ? "next" : undefined,
        dryRun: false,
        publishedPackages: [],
        publishFailure: "platform",
        resume: true,
      },
    );
    expect(result.interrupted.status).toBe(1);
    const option = source === "command" ? " --tag=next" : "";
    expect(result.interrupted.stderr).toContain(`pnpm release ${version}${option}\``);
    expect(result.status).toBe(0);
    const uploads = result.calls.filter(
      ({ command, commandArguments }) => command === "npm" && commandArguments[0] === "publish",
    );
    expect(uploads).toHaveLength(4);
    for (const { commandArguments } of uploads)
      expect(commandArguments).toContain(source === "command" ? "--tag=next" : "--tag=canary");
    expect(Object.values(result.published).map((manifest) => manifest.version)).toEqual(
      packages.map(() => version),
    );
    expect(result.remoteTags).toContain(`refs/tags/v${version}`);
  },
);

it("does not complete a partial release whose existing version is on another explicit channel", async () => {
  const result = await runRelease(() => undefined, { distributionTag: "next", dryRun: false });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("@dougongjs/reactive@next does not point to " + version);
  expect(Object.keys(result.published)).toEqual(["reactive"]);
  expect(result.recorded).toEqual([]);
});

it("recognizes a recorded release after its distribution channel moves", async () => {
  const result = await runRelease(() => undefined, {
    publishedPackages: [],
    distributionTag: "next",
    dryRun: false,
    resume: true,
    beforeResume(_git, workspace) {
      writeFileSync(join(workspace, "dist-tags.json"), "{}");
    },
  });
  expect(result.interrupted.status).toBe(0);
  expect(result.status).toBe(0);
  expect(
    result.calls.filter(({ commandArguments }) => commandArguments[0] === "publish"),
  ).toHaveLength(packages.length);
});

const registryRoutes = {
  fallback: "https://default.example.test/",
  scoped: "https://scoped.example.test/npm/",
  declared: "https://declared.example.test/releases/",
};

it.each([
  {
    route: "default registry override",
    settings: {},
    publishConfig: { registry: registryRoutes.declared },
    expected: {
      dougong: registryRoutes.fallback,
      platform: registryRoutes.declared,
      reactive: registryRoutes.fallback,
    },
  },
  {
    route: "package scope before default override",
    settings: { "@dougongjs:registry": registryRoutes.scoped },
    publishConfig: { registry: registryRoutes.declared },
    expected: {
      dougong: registryRoutes.fallback,
      platform: registryRoutes.scoped,
      reactive: registryRoutes.scoped,
    },
  },
  {
    route: "package scope override",
    settings: { "@dougongjs:registry": registryRoutes.scoped },
    publishConfig: { "@dougongjs:registry": registryRoutes.declared },
    expected: {
      dougong: registryRoutes.fallback,
      platform: registryRoutes.declared,
      reactive: registryRoutes.scoped,
    },
  },
  {
    route: "configured scope before default override",
    settings: { scope: "delivery", "@delivery:registry": registryRoutes.scoped },
    publishConfig: { registry: registryRoutes.declared },
    expected: {
      dougong: registryRoutes.scoped,
      platform: registryRoutes.scoped,
      reactive: registryRoutes.scoped,
    },
  },
])(
  "pins each package registry for all release operations ($route)",
  async ({ settings, publishConfig, expected }) => {
    const result = await runRelease(
      (_published, workspace) => {
        const path = join(workspace, "packages", "platform", "package.json");
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.publishConfig = publishConfig;
        writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
      },
      {
        registries: { registry: registryRoutes.fallback, ...settings },
        distributionTag: "next",
        dryRun: false,
        publishedPackages: [],
      },
    );
    expect(result).toMatchObject({ status: 0 });
    const commands = result.calls.filter(({ command }) => command === "npm");
    const identities = commands.filter(({ commandArguments }) => commandArguments[0] === "whoami");
    expect(
      identities
        .map(({ registryArguments }) =>
          registryArguments.find((arg) => arg.startsWith("--registry=")),
        )
        .sort(),
    ).toEqual([...new Set(Object.values(expected))].map((url) => "--registry=" + url).sort());
    for (const {
      commandArguments: [operation, reference],
      registryArguments,
    } of commands) {
      if (operation === "whoami") continue;
      const name =
        operation === "publish"
          ? basename(reference, ".tgz")
          : reference.split("@").at(-2).split("/").at(-1);
      expect(registryArguments).toEqual([
        "--scope=",
        "--registry=" + expected[name],
        ...(name === "dougong" ? [] : ["--@dougongjs:registry=" + expected[name]]),
      ]);
    }
  },
);

it("rejects credential-bearing registry URLs before any upload without echoing them", async () => {
  const result = await runRelease(() => undefined, {
    dryRun: false,
    publishedPackages: [],
    registries: { registry: "https://user:fixture-secret@example.test/" },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("without embedded credentials");
  expect(result.stdout + result.stderr).not.toContain("fixture-secret");
  expect(result.calls.filter(({ command }) => command === "npm")).toEqual([]);
});

it("waits for registry visibility before publishing dependents", async () => {
  const result = await runRelease(() => undefined, { dryRun: false, visibility: "delayed" });
  expect(result.status).toBe(0);
  expect(Object.keys(result.published)).toEqual(packages);
  const publication = result.calls.filter(
    ({ command, commandArguments }) =>
      command === "sleep" ||
      (command === "npm" && ["publish", "view"].includes(commandArguments[0])),
  );
  expect(
    publication
      .slice(packages.length)
      .map(({ command, commandArguments }) =>
        command === "sleep" ? command : commandArguments[0],
      ),
  ).toEqual(packages.slice(1).flatMap(() => ["publish", "view", "sleep", "view"]));
  expect(result.recorded).toEqual(["commit", "tag", "push"]);
});

it.each(["never", "unreadable"])(
  "does not advance a release when an accepted upload is %s",
  async (visibility) => {
    const result = await runRelease(() => undefined, { dryRun: false, visibility });
    expect(result.status).toBe(1);
    expect(Object.keys(result.published)).toEqual(["reactive"]);
    expect(result.recorded).toEqual([]);
    expect(
      result.calls.filter(
        ({ command, commandArguments }) => command === "npm" && commandArguments[0] === "publish",
      ),
    ).toHaveLength(1);
    expect(result.calls.filter(({ command }) => command === "sleep")).toHaveLength(
      visibility === "never" ? 120 : 0,
    );
    expect(result.stderr).toContain(
      visibility === "never" ? "not readable within 30 minutes" : "E503",
    );
  },
);

it("finishes release recording after every upload already completed", async () => {
  const result = await runRelease(() => undefined, { publishedPackages: packages, dryRun: false });
  expect(result.status).toBe(0);
  expect(result.recorded).toEqual(["commit", "tag", "push"]);
  expect(result.stdout.match(/already published, contents match/g)).toHaveLength(packages.length);
  expect(result.stdout).toContain("released");
});

it.each([
  { command: "diff", after: false, committed: false },
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
      publishedPackages: packages,
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
    expect(result.remoteReferences.split("\n")).toEqual([
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
    { publishedPackages: packages, dryRun: false },
  );
  expect(result.status).toBe(1);
  expect(result.recorded).toEqual([]);
  expect(result.stderr).toContain("README.md differs");
});

it("restores manifest bytes without publishing or recording a successful dry run", async () => {
  const result = await runRelease(() => undefined, { escapedNames: true });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("package.json versions restored");
  expect(result.recorded).toEqual([]);
  expect(
    result.calls.filter(
      ({ command, commandArguments }) => command === "npm" && commandArguments[0] === "publish",
    ),
  ).toEqual([]);
  expect(Object.keys(result.published)).toEqual(["reactive"]);
});

it.each([
  { field: "name", value: "@fixture/unexpected" },
  { field: "type", value: "commonjs" },
  { field: "version", value: "0.7.3" },
])("rejects a tarball carrying another $field before publication", async ({ field, value }) => {
  const result = await runRelease(() => undefined, { packedOverrides: { [field]: value } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`tarball declares ${field} ${value}`);
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
      packedOverrides: { dependencies: { "@dougongjs/reactive": range } },
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
  const result = await runRelease(() => undefined, { packedOverrides: { dependencies } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stdout).not.toContain("Dry run complete");
});

it("rejects an archive missing a declared secondary entrypoint before publishing anything", async () => {
  const result = await runRelease(
    (_root, workspace) => {
      rmSync(join(workspace, "packages/dougong/dist/advanced.d.ts"));
    },
    { dryRun: false, publishedPackages: [] },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("tarball is missing dist/advanced.d.ts");
  expect(
    result.calls.some(
      ({ command, commandArguments }) => command === "npm" && commandArguments[0] === "publish",
    ),
  ).toBe(false);
});

it("keeps independently staged files out of the release and preserves their staging", async () => {
  const result = await runRelease(() => undefined, { dryRun: false, concurrentEdit: "stage" });
  expect(result.status).toBe(0);
  expect(result.stagedFiles).toBe("other.txt");
  expect(result.committedFiles.split("\n").sort()).toEqual(
    packages.map((name) => `packages/${name}/package.json`).sort(),
  );
});

it("refuses a different source commit after uploads without tagging or pushing it", async () => {
  const result = await runRelease(() => undefined, { dryRun: false, concurrentEdit: "head" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("release source changed during publication");
  expect(
    result.calls.filter(
      ({ command, commandArguments }) => command === "npm" && commandArguments[0] === "publish",
    ),
  ).toHaveLength(1);
  expect(result.remoteReferences).toBe(`${result.initialHead}\trefs/heads/main`);
  expect(result.remoteTags).toBe("");
});

it.each(["tag-head", "push-refs"])(
  "records only the pinned release objects if local refs move during %s",
  async (concurrentEdit) => {
    const result = await runRelease(() => undefined, { dryRun: false, concurrentEdit });
    expect(result.status).toBe(0);
    expect(result.head).not.toBe(result.parent);
    expect(result.remoteReferences.split("\n")).toEqual([
      `${result.parent}\trefs/heads/main`,
      `${result.parent}\trefs/tags/v${version}^{}`,
    ]);
  },
);

it.each([true, false])(
  "preserves concurrent manifest edits on rollback (upload failed: %s)",
  async (failed) => {
    const result = await runRelease(() => undefined, {
      dryRun: false,
      concurrentEdit: "manifest",
      publishFailure: failed ? "dougong" : undefined,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("preserving external edits");
    expect(result.recorded).toEqual([]);
    expect(result.remoteTags).toBe("");
  },
);

it("does not upload when the verified checkout moves during packing", async () => {
  const result = await runRelease(() => undefined, {
    dryRun: false,
    concurrentEdit: "before-publish",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("release source changed during publication");
  expect(
    result.calls.filter(
      ({ command, commandArguments }) => command === "npm" && commandArguments[0] === "publish",
    ),
  ).toEqual([]);
  expect(result.remoteReferences).toBe(`${result.initialHead}\trefs/heads/main`);
});

it("lets Git recognize an unchanged resumed release after worktree line-ending conversion", async () => {
  const result = await runRelease(() => undefined, {
    dryRun: false,
    publishedPackages: packages,
    interruptAt: "push",
    interruptAfter: true,
    resume: true,
    beforeResume(git, workspace) {
      writeFileSync(
        join(workspace, ".git/info/attributes"),
        "packages/*/package.json text eol=crlf\n",
      );
      const files = packages.map((directory) => `packages/${directory}/package.json`);
      for (const file of files) rmSync(join(workspace, file));
      git(["checkout-index", "--force", "--", ...files]);
      git(["add", "--renormalize", "--", ...files]);
      expect(readFileSync(join(workspace, "packages/dougong/package.json"), "utf8")).toContain(
        "\r\n",
      );
      expect(git(["status", "--porcelain"])).toBe("");
    },
  });
  expect(result.status).toBe(0);
  expect(result.recorded.filter((action) => action === "commit")).toHaveLength(1);
});

it("refuses an ambiguous pack output even when the command prints one valid path", async () => {
  const result = await runRelease(() => undefined, { concurrentEdit: "ambiguous-archive" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Expected one regular package archive");
  expect(result.recorded).toEqual([]);
});

it("confirms file contents of a newly visible upload before publishing any dependent or recording Git", async () => {
  const result = await runRelease(() => undefined, {
    dryRun: false,
    publishedPackages: [],
    concurrentEdit: "registry-bytes",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("dist/index.js differs from this build");
  expect(Object.keys(result.published)).toEqual(["reactive"]);
  expect(result.recorded).toEqual([]);
});

it("publishes captured bytes even if a later pack rewrites an earlier archive", async () => {
  const result = await runRelease(() => undefined, {
    publishedPackages: [],
    dryRun: false,
    concurrentEdit: "rewrite-pack",
  });
  expect(result.status).toBe(0);
  expect(result.publishedCoreModule).toBe("export const signal = value => value;\n");
});

it("rejects build output changed between verification and packing before any package is uploaded", async () => {
  const result = await runRelease(() => undefined, {
    dryRun: false,
    publishedPackages: [],
    concurrentEdit: "build-before-pack",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("dist/index.js differs from the verified build");
  expect(result.published).toEqual({});
  expect(result.recorded).toEqual([]);
});

it.each([
  ["scripts", { postinstall: "node dist/index.js" }],
  ["bin", { injected: "dist/index.js" }],
  ["optionalDependencies", { injected: "1.0.0" }],
  ["peerDependencies", { injected: "^1.0.0" }],
  ["imports", { "#internal": "./unexpected.js" }],
])("rejects consumer behavior introduced only by packing (%s)", async (field, value) => {
  const result = await runRelease(() => undefined, { packedOverrides: { [field]: value } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(field);
  expect(result.recorded).toEqual([]);
});

it("checks the actual release version of every package before allowing the first upload", async () => {
  const result = await runRelease(() => undefined, { dryRun: false, publishedPackages: [] });
  expect(result.status).toBe(0);
  expect(result.calls.find(({ command }) => command === "gate-versions")?.commandArguments).toEqual(
    packages.map(() => version),
  );
});

it.each([
  ["alter-receipt", "archive changed after consumer verification"],
  ["undeclared-file", "binding.gyp differs from the verified build"],
])("does not upload bytes the consumer did not accept: %s", async (concurrentEdit, diagnostic) => {
  const result = await runRelease(() => undefined, {
    dryRun: false,
    publishedPackages: [],
    concurrentEdit,
  });
  expect(result.stderr).toContain(diagnostic);
  expect(result.published).toEqual({});
  expect(result.recorded).toEqual([]);
});

it("refuses destination metadata present only in a packed manifest", async () => {
  const result = await runRelease(() => undefined, {
    dryRun: false,
    publishedPackages: [],
    packedOverrides: { publishConfig: { registry: "https://fixture.invalid" } },
  });
  expect(result.stderr).toContain("publishConfig differs");
  expect(result.published).toEqual({});
});

it("preflights the fetched remote commit even when the tracking ref is stale", async () => {
  const result = await runRelease(() => undefined, {
    dryRun: false,
    publishedPackages: [],
    beforeRelease(git) {
      const ahead = git(["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "Remote change"]);
      git(["push", "origin", ahead + ":refs/heads/main"]);
      git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
      git(["config", "remote.origin.fetch", "+refs/heads/another:refs/remotes/origin/another"]);
    },
  });
  expect(result.stderr).toContain("behind origin/main");
  expect(result.published).toEqual({});
});

it("stops before the first upload when a competing release reserves the tag during verification", async () => {
  const result = await runRelease(() => undefined, {
    publishedPackages: [],
    dryRun: false,
    concurrentEdit: "remote-tag-during-gate",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("remote release refs changed");
  expect(result.published).toEqual({});
  expect(result.recorded).toEqual([]);
});

it("does not recreate a remotely deleted main while recording the release", async () => {
  const result = await runRelease(() => undefined, {
    publishedPackages: packages,
    dryRun: false,
    concurrentEdit: "remote-main-at-push",
  });
  expect(result.status).toBe(1);
  expect(result.remoteReferences).toBe("");
  expect(result.remoteTags).toBe("");
});

it("resumes with the verified tag object when the local annotation changes during the gate", async () => {
  let reserved;
  const result = await runRelease(() => undefined, {
    publishedPackages: packages,
    dryRun: false,
    interruptAt: "push",
    interruptAfter: true,
    resume: true,
    concurrentEdit: "retag-during-resume",
    beforeResume(git) {
      reserved = git(["rev-parse", `refs/tags/v${version}`]);
    },
  });
  expect(result.status).toBe(0);
  expect(result.remoteTags.split("\n")).toContain(`${reserved}\trefs/tags/v${version}`);
});
