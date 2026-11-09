import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { versionedManifest } from "./release-request.mjs";
import { releaseRecordProofFilename } from "./release-reference-transaction.mjs";

const releaseBranch = "main";
const sourceRemote = "origin";
const mainReference = `refs/heads/${releaseBranch}`;
const minimumGitVersion = [2, 48];
const referenceTransactionModule = new URL("./release-reference-transaction.mjs", import.meta.url);
const referenceTransactionSource = readFileSync(referenceTransactionModule);

async function assertGitVersion(session) {
  const version = await session.capture("git", ["--version"]);
  const match = /^git version (\d+)\.(\d+)(?:\.|\s|$)/u.exec(version);
  const [major, minor] = match?.slice(1).map(Number) ?? [];
  if (
    !match ||
    major < minimumGitVersion[0] ||
    (major === minimumGitVersion[0] && minor < minimumGitVersion[1])
  ) {
    throw new Error(
      `Release recording requires Git ${minimumGitVersion.join(".")} or newer with resolved reference-transaction updates`,
    );
  }
}

// Git owns recovery: only this exact manifest-only commit proves a pending release record.
async function isReleaseCommit(session, request, commit, parent) {
  if (
    (await session.capture("git", ["show", "-s", "--format=%B", commit])) !==
    `chore: release ${request.version}`
  ) {
    return false;
  }
  if (
    (await session.capture("git", ["rev-list", "--parents", "-n", "1", commit])) !==
    `${commit} ${parent}`
  ) {
    return false;
  }
  if (await session.capture("git", ["diff", "--summary", parent, commit])) return false;
  const changed = (await session.capture("git", ["diff", "--name-only", parent, commit])).split(
    "\n",
  );
  if (
    changed.some(
      (file) => !request.packages.some(({ directory }) => file === `${directory}/package.json`),
    )
  ) {
    return false;
  }
  for (const { directory } of request.packages) {
    const before = (
      await session.run("git", ["show", `${parent}:${directory}/package.json`], { stdio: "pipe" })
    ).stdout;
    const after = (
      await session.run("git", ["show", `${commit}:${directory}/package.json`], { stdio: "pipe" })
    ).stdout;
    if (!after.equals(versionedManifest(before, request.version))) return false;
  }
  return true;
}

async function inspectSource(session, request) {
  const branch = await session.capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== releaseBranch)
    throw new Error(`on branch '${branch}'; releases are cut from main`);
  const head = await session.capture("git", ["rev-parse", "HEAD"]);
  if (await session.capture("git", ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("working tree is not clean; commit or stash first");
  }
  await session.run("git", ["fetch", "--quiet", sourceRemote, releaseBranch]);
  const remoteMain = await session.capture("git", ["rev-parse", "FETCH_HEAD^{commit}"]);
  const ahead = await session.capture("git", ["rev-list", "--count", remoteMain + ".." + head]);
  const behind = await session.capture("git", ["rev-list", "--count", head + ".." + remoteMain]);
  if (behind !== "0") throw new Error(`local main is ${behind} commit(s) behind origin/main`);
  const pendingReleaseCommit =
    ahead === "1" && (await isReleaseCommit(session, request, head, remoteMain));
  if (ahead !== "0" && !pendingReleaseCommit) {
    throw new Error(`local main is ${ahead} commit(s) ahead of origin/main; push first`);
  }
  return Object.freeze({
    source: Object.freeze({ branch, head }),
    remoteMain,
    pendingReleaseCommit,
  });
}

async function inspectLocalTag(session, request, head, tag, tagReference) {
  const existingTag = (await session.capture("git", ["tag", "--list", tag]))
    ? await session.capture("git", ["rev-parse", tagReference])
    : undefined;
  if (
    existingTag &&
    (!request.packages.every(({ currentVersion }) => currentVersion === request.version) ||
      (await session.capture("git", ["cat-file", "-t", existingTag])) !== "tag" ||
      (await session.capture("git", ["rev-parse", `${existingTag}^{commit}`])) !== head)
  ) {
    throw new Error(`tag ${tag} already exists but does not record this release`);
  }
  return existingTag;
}

async function captureDestination(session) {
  // Multiple push destinations cannot share an atomic release, and the fetch endpoint may differ.
  const destinations = (
    await session.run("git", ["remote", "get-url", "--push", "--all", sourceRemote], {
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
    })
  ).stdout
    .replace(/\r?\n$/u, "")
    .split(/\r?\n/u);
  if (destinations.length !== 1 || !destinations[0])
    throw new Error("origin must have one push destination");
  const [url] = destinations;
  const configuredRemotes = new Set((await session.capture("git", ["remote"])).split("\n"));
  let name = "dougong-release";
  for (let suffix = 1; configuredRemotes.has(name); suffix++) name = `dougong-release-${suffix}`;
  // Explicit pushurl prevents a second application of pushInsteadOf to the captured URL.
  const configuration = Object.freeze([
    "-c",
    `remote.${name}.url=${url}`,
    "-c",
    `remote.${name}.pushurl=${url}`,
  ]);
  return Object.freeze({ name, url, configuration });
}

async function assertDestination(session, destination) {
  // Command-scoped remotes support this lookup; remote get-url requires a persisted remote.
  const observed = (
    await session.run(
      "git",
      [...destination.configuration, "ls-remote", "--get-url", destination.name],
      {
        stdio: ["ignore", "pipe", "inherit"],
        encoding: "utf8",
      },
    )
  ).stdout.replace(/\r?\n$/u, "");
  if (observed !== destination.url)
    throw new Error("Git release destination would be rewritten; refusing to publish");
}

async function readReferences(session, destination, tagReference) {
  await assertDestination(session, destination);
  return Object.freeze(
    (
      await session.capture("git", [
        ...destination.configuration,
        "ls-remote",
        "--refs",
        "--",
        destination.name,
        mainReference,
        tagReference,
      ])
    )
      .split("\n")
      .filter(Boolean)
      .sort(),
  );
}

export async function inspectReleaseRepository(session, request) {
  await assertGitVersion(session);
  const { source, remoteMain, pendingReleaseCommit } = await inspectSource(session, request);
  const tag = `v${request.version}`;
  const tagReference = `refs/tags/${tag}`;
  const existingTag = await inspectLocalTag(session, request, source.head, tag, tagReference);
  const destination = await captureDestination(session);
  const references = await readReferences(session, destination, tagReference);
  if (!references.includes(remoteMain + "\t" + mainReference))
    throw new Error(
      "origin push destination main differs from the fetched source; refusing to publish",
    );
  const remoteTag = references.find((line) => line.endsWith("\t" + tagReference)) ?? "";
  if (remoteTag && remoteTag !== existingTag + "\t" + tagReference)
    throw new Error(
      `origin already has a different release tag ${tag}; inspect it before publishing`,
    );
  console.log(
    `  main is clean${pendingReleaseCommit ? "; resuming its release record" : " and equals origin/main"} at ${source.head}`,
  );
  return new ReleaseRepository(
    session,
    request,
    Object.freeze({
      source,
      remoteMain,
      pendingReleaseCommit,
      tag,
      tagReference,
      existingTag,
      destination,
      references,
      remoteTag,
    }),
  );
}

class ReleaseRepository {
  #session;
  #request;
  #proof;

  constructor(session, request, proof) {
    this.#session = session;
    this.#request = request;
    this.#proof = proof;
  }

  get source() {
    return this.#proof.source;
  }

  get hasReleaseRecord() {
    return Boolean(this.#proof.pendingReleaseCommit || this.#proof.existingTag);
  }

  get isRecordedRemotely() {
    return this.#proof.remoteTag !== "";
  }

  async assertReadyToBump() {
    if (
      !(await this.#session.atSource(this.source)) ||
      (await this.#session.capture("git", ["status", "--porcelain", "--untracked-files=all"]))
    ) {
      throw new Error("release source changed while checking; refusing to bump manifests");
    }
  }

  async assertPublicationInputs(action) {
    if (!(await this.#session.atSource(this.source)))
      throw new Error(`release source changed during publication; refusing to ${action}`);
    this.#request.assertVersionedManifests(action);
  }

  async assertBuildSource() {
    await this.assertPublicationInputs("accept verified packages");
    const pathsOutsideManifests = [
      ".",
      ...this.#request.packages.map(({ directory }) => `:(exclude)${directory}/package.json`),
    ];
    if (
      await this.#session.capture("git", [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ...pathsOutsideManifests,
      ])
    )
      throw new Error("release source changed while checking; refusing to publish");
  }

  async assertRemoteReferences() {
    const { destination, tagReference, references } = this.#proof;
    // Registry uploads cannot be rolled back if the verified remote refs change during approval.
    if (
      (await readReferences(this.#session, destination, tagReference)).join("\n") !==
      references.join("\n")
    )
      throw new Error("remote release refs changed since preflight; refusing to publish");
  }

  async record() {
    await this.assertPublicationInputs("record");
    const commit = await this.#recordManifestCommit();
    const tagObject = await this.#recordTag(commit);
    await this.#pushRecord(commit, tagObject);
  }

  async #recordManifestCommit() {
    const { head } = this.source;
    const { manifestFiles, version } = this.#request;
    const index = resolve(await this.#session.capture("git", ["rev-parse", "--git-path", "index"]));
    const indexLock = `${index}.lock`;
    const lockDescriptor = openSync(indexLock, "wx");
    let discardIndex = true;
    let directory;
    let commit = head;
    const failures = [];
    try {
      closeSync(lockDescriptor);
      copyFileSync(index, indexLock);
      directory = mkdtempSync(join(dirname(index), "release-record-"));
      const hookFilename = basename(fileURLToPath(referenceTransactionModule));
      writeFileSync(join(directory, hookFilename), referenceTransactionSource, { mode: 0o755 });
      symlinkSync(hookFilename, join(directory, "reference-transaction"));
      symlinkSync(process.execPath, join(directory, "node"));
      const configuration = ["-c", `core.hooksPath=${directory}`];
      const pendingIndex = { env: { ...process.env, GIT_INDEX_FILE: indexLock } };
      const staged = await this.#session.execute(
        "git",
        [...configuration, "diff", "--cached", "--quiet", head, "--", ...manifestFiles],
        { ...pendingIndex, stdio: "inherit" },
      );
      if (staged.error || staged.status !== 0)
        throw new Error(
          "release manifests have staged changes or the index is unreadable; refusing to replace them",
        );
      const candidateIndex = {
        env: { ...process.env, GIT_INDEX_FILE: join(directory, "index") },
      };
      await this.#session.run("git", [...configuration, "read-tree", head], candidateIndex);
      // Git's clean filters decide whether worktree bytes represent a different tree.
      await this.#session.run(
        "git",
        [...configuration, "add", "--", ...manifestFiles],
        candidateIndex,
      );
      const tree = await this.#session.capture(
        "git",
        [...configuration, "write-tree"],
        candidateIndex,
      );
      if (tree === (await this.#session.capture("git", ["rev-parse", `${head}^{tree}`]))) {
        this.#session.relinquishManifestRestoration();
      } else {
        const message = `chore: release ${version}`;
        commit = await this.#session.capture("git", [
          "commit-tree",
          tree,
          "-p",
          head,
          "-m",
          message,
        ]);
        if (!(await isReleaseCommit(this.#session, this.#request, commit, head)))
          throw new Error("Git commit differs from the verified release; refusing to tag or push");
        await this.#session.run(
          "git",
          [...configuration, "restore", `--source=${commit}`, "--staged", "--", ...manifestFiles],
          pendingIndex,
        );
        writeFileSync(
          join(directory, releaseRecordProofFilename),
          JSON.stringify({ reference: mainReference, head, commit }),
          { flag: "wx", mode: 0o400 },
        );
        await this.#session.recordCommit(
          { source: this.source, reference: mainReference, commit, directory, message },
          {
            path: indexLock,
            retain() {
              discardIndex = false;
            },
            publish() {
              // After ref publication, a failed rename must retain the prepared index for recovery.
              discardIndex = false;
              renameSync(indexLock, index);
            },
          },
        );
      }
    } catch (error) {
      failures.push(error);
    } finally {
      for (const cleanup of [
        () => {
          if (discardIndex) rmSync(indexLock, { force: true });
        },
        () => {
          if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
        },
      ]) {
        try {
          cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Release recording failed");
    return commit;
  }

  async #recordTag(commit) {
    const { existingTag, tag, tagReference } = this.#proof;
    if (!existingTag)
      await this.#session.run("git", [
        "tag",
        "-a",
        tag,
        commit,
        "-m",
        `Dougong ${this.#request.version}`,
      ]);
    const tagObject =
      existingTag ?? (await this.#session.capture("git", ["rev-parse", tagReference]));
    if (
      (await this.#session.capture("git", ["cat-file", "-t", tagObject])) !== "tag" ||
      (await this.#session.capture("git", ["rev-parse", `${tagObject}^{commit}`])) !== commit
    )
      throw new Error(`tag ${tag} does not record the verified release; refusing to push`);
    return tagObject;
  }

  async #pushRecord(commit, tagObject) {
    const { destination, remoteMain, tagReference, remoteTag } = this.#proof;
    // Pin both sides: a plain fast-forward push can recreate a branch somebody just deleted.
    await assertDestination(this.#session, destination);
    const push = await this.#session.execute(
      "git",
      [
        ...destination.configuration,
        "push",
        "--atomic",
        "--no-follow-tags",
        `--force-with-lease=${mainReference}:${remoteMain}`,
        `--force-with-lease=${tagReference}:${remoteTag.split("\t")[0]}`,
        "--",
        destination.name,
        `${commit}:${mainReference}`,
        `${tagObject}:${tagReference}`,
      ],
      { stdio: "inherit" },
    );
    if (push.error) throw new Error(`git push could not start: ${push.error.message}`);
    // The command-scoped remote owns no tracking refs; fetch observes origin's read endpoint.
    const refresh = await this.#session.execute(
      "git",
      ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", sourceRemote, releaseBranch],
      { stdio: "inherit" },
    );
    if (push.status !== 0)
      throw new Error(
        `Git did not confirm the atomic push. Re-run \`${this.#request.resumeCommand}\` to inspect the remote state and resume.`,
      );
    if (refresh.error || refresh.status !== 0)
      console.warn("Release pushed; fetch origin to refresh local tracking refs.");
  }
}
