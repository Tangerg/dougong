import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { executeRelease, releaseTestTimeout } from "./release-fixture.mjs";

vi.setConfig({ testTimeout: releaseTestTimeout });
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const release = fileURLToPath(new URL("../release.mjs", import.meta.url));
const version = "0.7.2";
const packages = ["reactive", "core", "platform", "dougong"];

const preload = fileURLToPath(new URL("./fixtures/release-artifacts.mjs", import.meta.url));

async function runRelease(
  mutate,
  {
    packedOverrides = {},
    declaredDependencies = { "@standard-schema/spec": "^1.0.0" },
    escapedNames = false,
    publishedPackages = ["reactive"],
    publishedArchivePrefix = "",
    dryRun = true,
    realPack = false,
    publishFailure,
    visibility = "immediate",
    otp,
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
    for (const name of ["tar", "gzip"]) {
      const executable = (process.env.PATH ?? "")
        .split(delimiter)
        .map((directory) => join(directory, name))
        .find((path) => existsSync(path));
      if (!executable) throw new Error(`Release fixture requires ${name}`);
      symlinkSync(executable, join(bin, name));
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
      const manifest =
        `${JSON.stringify({ name: packageName, version: "0.7.1", ...(name === "core" ? { dependencies: declaredDependencies } : {}) }, null, 2)}\n`.replace(
          packageName,
          escapedNames ? packageName.replace("d", "\\u0064") : packageName,
        );
      const path = join(workspace, "packages", name, "package.json");
      mkdirSync(join(workspace, "packages", name), { recursive: true });
      writeFileSync(path, manifest);
      const files = {
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
            JSON.stringify({ ...JSON.parse(manifest), version }, null, 2),
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
    const realGit = !dryRun
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
    let initialHead;
    if (!dryRun) {
      if (!realGit) throw new Error("Release recording fixture requires git");
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
          "/release-stage",
          "/package.json",
          "/pnpm-workspace.yaml",
          "",
        ].join("\n"),
      );
    }
    const pnpm = realPack
      ? (process.env.PATH ?? "")
          .split(delimiter)
          .map((directory) => join(directory, "pnpm"))
          .find((path) => existsSync(path))
      : undefined;
    if (realPack && !pnpm) throw new Error("Release packaging fixture requires pnpm");
    const execute = async (interruption, publicationFailure) => {
      try {
        return await executeRelease(
          [
            "--import",
            preload,
            release,
            version,
            dryRun ? "--dry-run" : "--yes",
            ...(otp ? [`--otp=${otp}`] : []),
          ],
          {
            cwd: workspace,
            env: {
              ...environment,
              PATH: bin,
              DOUGONG_RELEASE_PACKED_OVERRIDES: JSON.stringify(packedOverrides),
              DOUGONG_RELEASE_REAL_GIT: realGit ?? "",
              DOUGONG_RELEASE_REAL_PNPM: pnpm ?? "",
              DOUGONG_RELEASE_PUBLISH_FAILURE: publicationFailure ?? "",
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
          tag: git(["tag", "--list", `v${version}`]),
        }
      : undefined;
    if (resume) beforeResume(git, workspace);
    const result = resume ? await execute(undefined) : interrupted;
    const head = realGit ? git(["rev-parse", "HEAD"]) : undefined;
    for (const [path, contents] of originals) {
      const expected =
        realGit && head !== initialHead
          ? `${JSON.stringify({ ...JSON.parse(contents), version }, null, 2)}\n`
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
      published: publishedManifests(),
      calls,
      recorded: calls.filter(({ command }) => command === "git").map(({ args }) => args[0]),
      remoteRefs: realGit
        ? git(["ls-remote", "origin", "refs/heads/main", `refs/tags/v${version}^{}`])
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

it("preserves remote main when the remote release tag conflicts", async () => {
  const result = await runRelease(() => undefined, {
    publishedPackages: packages,
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

it.each([undefined, "123456"])(
  "publishes inspected tarballs and confirms every upload before recording the release (OTP: %s)",
  async (otp) => {
    const result = await runRelease(() => undefined, { dryRun: false, otp });
    expect(result.status).toBe(0);
    expect(Object.keys(result.published)).toEqual(packages);
    expect(Object.values(result.published).map((manifest) => manifest.version)).toEqual(
      packages.map(() => version),
    );
    const publication = result.calls.filter(
      ({ command, args }) => command === "npm" && ["publish", "view"].includes(args[0]),
    );
    expect(publication.map(({ args }) => args[0])).toEqual([
      "view",
      "view",
      "view",
      "view",
      "publish",
      "view",
      "publish",
      "view",
      "publish",
      "view",
    ]);
    for (const { args } of publication.filter(({ args }) => args[0] === "publish")) {
      expect(args.slice(2)).toEqual(["--access", "public", ...(otp ? [`--otp=${otp}`] : [])]);
      expect(args[1]).toMatch(/\.tgz$/);
    }
    expect(result.calls.slice(-4).map(({ command }) => command)).toEqual([
      "git",
      "git",
      "git",
      "git",
    ]);
    expect(result.recorded).toEqual(["add", "commit", "tag", "push"]);
    expect(result.remoteRefs.split("\n")).toEqual([
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
      ({ command, args }) => command === "npm" && args[0] === "publish",
    );
    expect(uploads.map(({ args }) => args[1].split("/").at(-1))).toEqual(
      packages.map((name) => `${name}.tgz`),
    );
    expect(result.recorded).toEqual(["add", "commit", "tag", "push"]);
    expect(result.remoteRefs.split("\n")).toEqual([
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
        const dependency = join(workspace, "packages/core/node_modules/@dougongjs/reactive");
        mkdirSync(dirname(dependency), { recursive: true });
        symlinkSync(join(workspace, "packages/reactive"), dependency);
        if (contents === "complete") return;
        if (contents === "directory README.md") {
          const path = join(workspace, "packages/core/README.md");
          rmSync(path);
          mkdirSync(path);
          writeFileSync(join(path, "notice.txt"), "Not the required file\n");
          return;
        }
        const path = join(workspace, "packages/core/package.json");
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.files = ["README.md", "LICENSE"];
        writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
      },
      {
        realPack: true,
        declaredDependencies: { "@dougongjs/reactive": "workspace:*" },
      },
    );
    expect(result.status).toBe(contents === "complete" ? 0 : 1);
    expect(result[contents === "complete" ? "stdout" : "stderr"]).toContain(
      contents === "complete"
        ? "Dry run complete"
        : `tarball is missing ${contents === "excluded dist" ? "dist/index.js" : "README.md"}`,
    );
  },
);

it.each(["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE"])(
  "rejects a candidate missing %s",
  async (file) => {
    const result = await runRelease((_published, workspace) => {
      rmSync(join(workspace, "packages/core", file));
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`tarball is missing ${file}`);
    expect(result.recorded).toEqual([]);
  },
);

it.each(["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE"])(
  "rejects a directory in place of the required file %s",
  async (file) => {
    const result = await runRelease((_published, workspace) => {
      const path = join(workspace, "packages/core", file);
      rmSync(path);
      mkdirSync(path);
      writeFileSync(join(path, "notice.txt"), "Not the required file\n");
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`tarball is missing ${file}`);
    expect(result.recorded).toEqual([]);
  },
);

it("rejects non-regular candidate entries before first publication", async () => {
  const result = await runRelease((_published, workspace) => {
    symlinkSync("index.d.ts", join(workspace, "packages/core/dist/linked.d.ts"));
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
      const root = side === "candidate" ? join(workspace, "packages/core") : published;
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
    writeFileSync(join(workspace, "packages/core", file), `export * from "${reference}";\n`);
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
    expect(Object.keys(result.publishedAfterFirstAttempt)).toEqual(["reactive", "core"]);
    const uploads = result.calls.filter(
      ({ command, args }) => command === "npm" && args[0] === "publish",
    );
    expect(uploads.map(({ args }) => args[1].split("/").at(-1))).toEqual(
      resume
        ? ["core.tgz", "platform.tgz", "platform.tgz", "dougong.tgz"]
        : ["core.tgz", "platform.tgz"],
    );
    expect(result.status).toBe(resume ? 0 : 1);
    expect(result.recorded).toEqual(resume ? ["add", "commit", "tag", "push"] : []);
    expect(Object.keys(result.published)).toEqual(resume ? packages : ["reactive", "core"]);
  },
);

it("waits for registry visibility before publishing dependents", async () => {
  const result = await runRelease(() => undefined, { dryRun: false, visibility: "delayed" });
  expect(result.status).toBe(0);
  expect(Object.keys(result.published)).toEqual(packages);
  const publication = result.calls.filter(
    ({ command, args }) =>
      command === "sleep" || (command === "npm" && ["publish", "view"].includes(args[0])),
  );
  expect(
    publication.slice(4).map(({ command, args }) => (command === "sleep" ? command : args[0])),
  ).toEqual([
    "publish",
    "view",
    "sleep",
    "view",
    "publish",
    "view",
    "sleep",
    "view",
    "publish",
    "view",
    "sleep",
    "view",
  ]);
  expect(result.recorded).toEqual(["add", "commit", "tag", "push"]);
});

it.each(["never", "unreadable"])(
  "does not advance a release when an accepted upload is %s",
  async (visibility) => {
    const result = await runRelease(() => undefined, { dryRun: false, visibility });
    expect(result.status).toBe(1);
    expect(Object.keys(result.published)).toEqual(["reactive"]);
    expect(result.recorded).toEqual([]);
    expect(
      result.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish"),
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
    result.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish"),
  ).toEqual([]);
  expect(Object.keys(result.published)).toEqual(["reactive"]);
});

it.each([
  { field: "name", value: "@fixture/unexpected" },
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
