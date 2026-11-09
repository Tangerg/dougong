import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { inspectReleaseRepository } from "../release/release-repository.mjs";
import { executeRelease } from "./release-fixture.mjs";

const fixture = fileURLToPath(new URL("./fixtures/release-record.mjs", import.meta.url));
const packageDirectories = ["reactive", "dougong", "platform"];
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

async function recordRelease(scenario, inspect) {
  const directory = mkdtempSync(join(tmpdir(), "dougong-release-record-test-"));
  const workspace = join(directory, "workspace");
  const remote = join(directory, "remote.git");
  mkdirSync(workspace);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  try {
    git(["init", "--initial-branch=main"]);
    git(["config", "user.name", "Release fixture"]);
    git(["config", "user.email", "release@example.invalid"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["config", "tag.gpgsign", "false"]);
    for (const name of packageDirectories) {
      mkdirSync(join(workspace, "packages", name), { recursive: true });
      writeFileSync(
        join(workspace, "packages", name, "package.json"),
        JSON.stringify({ name, version: "1.0.0" }, null, 2) + "\n",
      );
    }
    writeFileSync(join(workspace, "other.txt"), "original\n");
    git(["add", "."]);
    git(["commit", "-m", "Source"]);
    const source = git(["rev-parse", "HEAD"]);
    git(["clone", "--bare", workspace, remote]);
    git(["remote", "add", "origin", remote]);
    writeFileSync(join(workspace, ".git/info/exclude"), "/record-observation.json\n");
    let result;
    try {
      result = await executeRelease([fixture, scenario], { cwd: workspace, env: environment });
    } catch (error) {
      if (scenario !== "cancel-before-record" || error.signal !== "SIGTERM") throw error;
      result = { status: error.status, signal: error.signal, stderr: error.stderr };
    }
    const observation = JSON.parse(
      readFileSync(join(workspace, "record-observation.json"), "utf8"),
    );
    await inspect({ result, observation, source, git, workspace });
    expect(
      readdirSync(join(workspace, ".git")).filter((name) => name.startsWith("release-record-")),
    ).toEqual([]);
    expect(existsSync(join(workspace, ".git/index.lock"))).toBe(
      [
        "existing-lock",
        "advanced-ref",
        "cleanup-failure",
        "readback-failure",
        "head-after-record",
        "ref-after-record",
        "projection-failure",
      ].includes(scenario),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.each(["same-sha", "different-sha", "changed-symref", "aliased-main"])(
  "preserves another owner's branch and index when the source changes (%s)",
  async (scenario) => {
    await recordRelease(scenario, ({ result, observation, source, git, workspace }) => {
      expect(git(["rev-parse", "another-owner"])).toBe(observation.otherOwnerHead);
      expect(result.status).toBe(1);
      expect(observation.recorded).toBe(false);
      expect(git(["symbolic-ref", "HEAD"])).toBe("refs/heads/another-owner");
      expect(git(["rev-parse", "main"])).toBe(source);
      expect(git(["tag", "--list"])).toBe("");
      expect(git(["ls-remote", "origin", "refs/heads/main"])).toBe(`${source}\trefs/heads/main`);
      expect(readFileSync(join(workspace, ".git/index")).toString("base64")).toBe(
        observation.index,
      );
    });
  },
);

it("refuses an advanced main ref without replacing its commit or the captured index", async () => {
  await recordRelease("advanced-ref", ({ result, observation, source, git, workspace }) => {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("prepared index retained at");
    expect(git(["rev-parse", "HEAD"])).toBe(observation.otherOwnerHead);
    expect(git(["tag", "--list"])).toBe("");
    expect(git(["ls-remote", "origin", "refs/heads/main"])).toBe(`${source}\trefs/heads/main`);
    expect(readFileSync(join(workspace, ".git/index")).toString("base64")).toBe(observation.index);
  });
});

it("leaves an existing index lock owned by another operation untouched", async () => {
  await recordRelease("existing-lock", ({ result, source, git, workspace }) => {
    expect(result.status).toBe(1);
    expect(git(["rev-parse", "HEAD"])).toBe(source);
    expect(readFileSync(join(workspace, ".git/index.lock"), "utf8")).toBe("another owner's lock");
  });
});

it("preserves independently staged and unstaged versions while committing only manifests", async () => {
  await recordRelease("staged-files", ({ result, source, git, workspace }) => {
    expect(result.status).toBe(0);
    expect(git(["show", ":other.txt"])).toBe("staged by another owner");
    expect(readFileSync(join(workspace, "other.txt"), "utf8")).toBe(
      "working tree belongs to another owner\n",
    );
    expect(git(["show", "HEAD:other.txt"])).toBe("original");
    expect(git(["diff", "--cached", "--name-only"])).toBe("other.txt");
    expect(git(["diff", "--name-only", source, "HEAD"]).split("\n").sort()).toEqual(
      packageDirectories.map((name) => `packages/${name}/package.json`).sort(),
    );
  });
});

it("refuses staged manifest edits without replacing the index owner", async () => {
  await recordRelease("staged-manifest", ({ result, observation, source, git, workspace }) => {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release manifests have staged changes");
    expect(git(["rev-parse", "HEAD"])).toBe(source);
    expect(readFileSync(join(workspace, ".git/index")).toString("base64")).toBe(observation.index);
  });
});

it("records the verified commit without running checkout commit or index hooks", async () => {
  await recordRelease("commit-hooks", ({ result, source, git, workspace }) => {
    expect(result.status).toBe(0);
    expect(existsSync(join(workspace, ".git/unverified-hook"))).toBe(false);
    expect(git(["rev-parse", "HEAD^"])).toBe(source);
    expect(git(["log", "-1", "--format=%B"])).toBe("chore: release 1.1.0");
    expect(git(["status", "--porcelain"])).toBe("");
  });
});

it("rejects a clean filter that changes verified manifest content before any ref advances", async () => {
  await recordRelease("clean-filter", ({ result, observation, source, git, workspace }) => {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Git commit differs from the verified release");
    expect(git(["rev-parse", "HEAD"])).toBe(source);
    expect(git(["tag", "--list"])).toBe("");
    expect(readFileSync(join(workspace, ".git/index")).toString("base64")).toBe(observation.index);
  });
});

it("cancels before ref publication and removes private recording files without leaving a commit", async () => {
  await recordRelease("cancel-before-record", ({ result, source, git }) => {
    expect(result).toMatchObject({ status: null, signal: "SIGTERM" });
    expect(git(["rev-parse", "HEAD"])).toBe(source);
    expect(git(["status", "--porcelain"])).toBe("");
    expect(git(["tag", "--list"])).toBe("");
  });
});

it("synchronizes a completed ref update even when its command acknowledgement failed", async () => {
  await recordRelease("after-effect-failure", ({ result, observation, git, workspace }) => {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Fixture lost ref-update acknowledgement");
    expect(git(["rev-parse", "HEAD"])).toBe(observation.releaseCommit);
    expect(git(["status", "--porcelain"])).toBe("");
    expect(git(["tag", "--list"])).toBe("");
    expect(
      JSON.parse(readFileSync(join(workspace, "packages/dougong/package.json"), "utf8")).version,
    ).toBe("1.1.0");
  });
});

it("reports the original verification failure and still removes private files when lock cleanup fails", async () => {
  await recordRelease("cleanup-failure", ({ result, source, git }) => {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Git commit differs from the verified release");
    expect(result.stderr).toContain("Fixture index cleanup failed");
    expect(git(["rev-parse", "HEAD"])).toBe(source);
    expect(git(["tag", "--list"])).toBe("");
  });
});

it.each([
  {
    scenario: "readback-failure",
    verify({ result }) {
      expect(result.stderr).toContain("Fixture lost ref-update acknowledgement");
      expect(result.stderr).toContain("Fixture ref readback failed");
    },
  },
  {
    scenario: "head-after-record",
    verify({ git, source }) {
      expect(git(["symbolic-ref", "HEAD"])).toBe("refs/heads/another-owner");
      expect(git(["rev-parse", "another-owner"])).toBe(source);
    },
  },
  {
    scenario: "ref-after-record",
    verify({ git, observation }) {
      expect(git(["rev-parse", "main"])).toBe(observation.otherOwnerHead);
    },
  },
  {
    scenario: "projection-failure",
    verify({ result }) {
      expect(result.stderr).toContain("Fixture index publication failed");
    },
  },
])(
  "retains an uncertain index projection and both original and recovery evidence ($scenario)",
  async ({ scenario, verify }) => {
    await recordRelease(scenario, (state) => {
      const { result, observation, source, git, workspace } = state;
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("prepared index retained at");
      expect(result.stderr).toContain("refs/heads/main");
      expect(result.stderr).toContain(source);
      expect(result.stderr).toContain(observation.releaseCommit);
      expect(result.stderr).toContain(join(workspace, ".git/index.lock"));
      expect(git(["tag", "--list"])).toBe("");
      expect(readFileSync(join(workspace, ".git/index")).toString("base64")).toBe(
        observation.index,
      );
      expect(
        JSON.parse(readFileSync(join(workspace, "packages/dougong/package.json"), "utf8")).version,
      ).toBe("1.1.0");
      verify(state);
    });
  },
);

it.each(["git version 2.47.9", "git version 2.28.0", "git version 1.9.1", "unknown Git"])(
  "rejects unsupported Git before inspecting or changing release state (%s)",
  async (version) => {
    const commands = [];
    const session = {
      async capture(command, arguments_) {
        commands.push([command, ...arguments_]);
        return version;
      },
    };
    await expect(inspectReleaseRepository(session, {})).rejects.toThrow(
      "requires Git 2.48 or newer",
    );
    expect(commands).toEqual([["git", "--version"]]);
  },
);
