#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { valid, validRange } from "semver";
import { manifestPath, ReleaseSession } from "./release-session.mjs";
import { packageArchiveIn, readPackageFiles } from "../package-archive.mjs";
import { packageName, publishedDirectories } from "../packages.mjs";
import {
  candidateOutput,
  differingFile,
  readVerifiedCandidates,
  verifyManifest,
} from "../consumer/package-candidates.mjs";

function step(message) {
  console.log(`\n[1m▸ ${message}[0m`);
}

function versionedManifest(contents, version) {
  const manifest = JSON.parse(contents);
  manifest.version = version;
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

async function release(session) {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("Releases require Linux or macOS with git, npm and pnpm executables on PATH");
  }

  const input = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      yes: { type: "boolean" },
      otp: { type: "string" },
      tag: { type: "string" },
    },
    allowPositionals: true,
    tokens: true,
  });
  const { values, positionals, tokens } = input;
  if (positionals.length !== 1) {
    throw new Error(
      "usage: node tooling/release/release.mjs <version> [--dry-run] [--yes] [--tag=<dist-tag>] [--otp=<code>]",
    );
  }
  const seenOptions = new Set();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seenOptions.has(token.name))
      throw new Error(`Option '--${token.name}' must be specified once`);
    seenOptions.add(token.name);
  }
  const [version] = positionals;
  if (valid(version) !== version) {
    throw new Error(`'${version}' is not a canonical semantic version`);
  }
  const dryRun = values["dry-run"] === true;
  const assumeYes = values.yes === true;
  const oneTimePassword = values.otp;
  if (oneTimePassword !== undefined && !oneTimePassword.trim())
    throw new Error("--otp must be a non-empty code");

  const PACKAGES = publishedDirectories.map((directory) => {
    const original = readFileSync(manifestPath(directory));
    const manifest = JSON.parse(original);
    const name = packageName(manifest.name);
    const distributionTag = values.tag === undefined ? manifest.publishConfig?.tag : values.tag;
    if (distributionTag === undefined)
      throw new Error(`${name}: a release needs --tag=<dist-tag> or publishConfig.tag`);
    if (
      typeof distributionTag !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(distributionTag) ||
      validRange(distributionTag) !== null
    )
      throw new Error(`${name}: invalid npm dist-tag; use a channel name such as next or beta`);
    return {
      directory,
      name,
      distributionTag,
      publishConfig: manifest.publishConfig,
      currentVersion: manifest.version,
      original,
      versioned: versionedManifest(original, version),
    };
  });
  if (new Set(PACKAGES.map(({ name }) => name)).size !== PACKAGES.length)
    throw new Error("Release package names must be unique");
  const resumeCommand = `pnpm release ${version}${values.tag === undefined ? "" : ` --tag=${values.tag}`}`;
  const manifestFiles = PACKAGES.map(({ directory }) => manifestPath(directory));

  const current = PACKAGES[0].currentVersion;
  console.log(`\nDougong release: ${current} → ${version}${dryRun ? "  (dry run)" : ""}`);

  // Publish only reproducible source states so recovery cannot include unrelated commits.

  step("Verifying repository state");

  const branch = await session.capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") throw new Error(`on branch '${branch}'; releases are cut from main`);
  const head = await session.capture("git", ["rev-parse", "HEAD"]);
  const source = { branch, head };

  if (await session.capture("git", ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("working tree is not clean; commit or stash first");
  }

  await session.run("git", ["fetch", "--quiet", "origin", "main"]);
  const remoteMain = await session.capture("git", ["rev-parse", "FETCH_HEAD^{commit}"]);
  const ahead = await session.capture("git", ["rev-list", "--count", remoteMain + ".." + head]);
  const behind = await session.capture("git", ["rev-list", "--count", head + ".." + remoteMain]);
  if (behind !== "0") throw new Error(`local main is ${behind} commit(s) behind origin/main`);

  // Git owns the release record; a separate recovery marker could disagree with the actual commit.
  async function isReleaseCommit(commit, parent) {
    if (
      (await session.capture("git", ["show", "-s", "--format=%B", commit])) !==
      `chore: release ${version}`
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
        (file) => !PACKAGES.some(({ directory }) => file === `${directory}/package.json`),
      )
    ) {
      return false;
    }
    for (const { directory } of PACKAGES) {
      const before = (
        await session.run("git", ["show", `${parent}:${directory}/package.json`], { stdio: "pipe" })
      ).stdout;
      const after = (
        await session.run("git", ["show", `${commit}:${directory}/package.json`], { stdio: "pipe" })
      ).stdout;
      if (!after.equals(versionedManifest(before, version))) return false;
    }
    return true;
  }

  const pendingReleaseCommit = ahead === "1" && (await isReleaseCommit(head, remoteMain));
  if (ahead !== "0" && !pendingReleaseCommit) {
    throw new Error(`local main is ${ahead} commit(s) ahead of origin/main; push first`);
  }

  const tag = `v${version}`;
  const mainReference = "refs/heads/main";
  const tagReference = `refs/tags/${tag}`;
  const existingTag = (await session.capture("git", ["tag", "--list", tag]))
    ? await session.capture("git", ["rev-parse", tagReference])
    : undefined;
  if (
    existingTag &&
    (!PACKAGES.every(({ currentVersion }) => currentVersion === version) ||
      (await session.capture("git", ["cat-file", "-t", existingTag])) !== "tag" ||
      (await session.capture("git", ["rev-parse", `${existingTag}^{commit}`])) !== head)
  ) {
    throw new Error(`tag ${tag} already exists but does not record this release`);
  }
  // A push URL can differ from the fetch URL; several push destinations cannot share an atomic release.
  const destinations = (
    await session.run("git", ["remote", "get-url", "--push", "--all", "origin"], {
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
    })
  ).stdout
    .replace(/\r?\n$/u, "")
    .split(/\r?\n/u);
  if (destinations.length !== 1 || !destinations[0])
    throw new Error("origin must have one push destination");
  const [destination] = destinations;
  const configuredRemotes = new Set((await session.capture("git", ["remote"])).split("\n"));
  let releaseRemote = "dougong-release";
  for (let suffix = 1; configuredRemotes.has(releaseRemote); suffix++)
    releaseRemote = `dougong-release-${suffix}`;
  // An explicit pushurl prevents Git from applying pushInsteadOf a second time to the captured URL.
  const releaseRemoteConfiguration = [
    "-c",
    `remote.${releaseRemote}.url=${destination}`,
    "-c",
    `remote.${releaseRemote}.pushurl=${destination}`,
  ];
  async function assertReleaseDestination() {
    // Command-scoped remotes support this local lookup; remote get-url requires a persisted remote.
    const observed = (
      await session.run(
        "git",
        [...releaseRemoteConfiguration, "ls-remote", "--get-url", releaseRemote],
        { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" },
      )
    ).stdout.replace(/\r?\n$/u, "");
    if (observed !== destination)
      throw new Error("Git release destination would be rewritten; refusing to publish");
  }
  async function releaseReferences() {
    await assertReleaseDestination();
    return (
      await session.capture("git", [
        ...releaseRemoteConfiguration,
        "ls-remote",
        "--refs",
        "--",
        releaseRemote,
        mainReference,
        tagReference,
      ])
    )
      .split("\n")
      .filter(Boolean)
      .sort();
  }
  const verifiedReferences = await releaseReferences();
  if (!verifiedReferences.includes(remoteMain + "\t" + mainReference))
    throw new Error(
      "origin push destination main differs from the fetched source; refusing to publish",
    );
  const remoteTag = verifiedReferences.find((line) => line.endsWith("\t" + tagReference)) ?? "";
  if (remoteTag && remoteTag !== existingTag + "\t" + tagReference)
    throw new Error(
      `origin already has a different release tag ${tag}; inspect it before publishing`,
    );
  console.log(
    `  main is clean${pendingReleaseCommit ? "; resuming its release record" : " and equals origin/main"} at ${head}`,
  );

  step("Verifying registry state");

  for (const { directory, original } of PACKAGES) {
    if (!readFileSync(manifestPath(directory)).equals(original))
      throw new Error(`${directory}/package.json changed since release input capture`);
  }

  const npmSettings = new Map();
  async function npmSetting(key) {
    if (!npmSettings.has(key)) {
      const value = await session.capture("npm", ["config", "get", key], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      npmSettings.set(key, value === "undefined" || !value ? undefined : value);
    }
    return npmSettings.get(key);
  }

  function packageScope(name) {
    return name.startsWith("@") ? name.split("/")[0] : undefined;
  }

  async function resolveRegistry({ name, publishConfig: publishConfiguration }) {
    const scope = packageScope(name);
    const scoped = async (scopeName) => {
      if (!scopeName) return undefined;
      if (typeof scopeName !== "string" || !/^@?[^@:/\s]+$/u.test(scopeName))
        throw new Error(`${name}: invalid npm registry scope`);
      const key = scopeName.replace(/^@?/u, "@") + ":registry";
      return publishConfiguration?.[key] ?? (await npmSetting(key));
    };
    const raw =
      (await scoped(scope)) ??
      (await scoped(publishConfiguration?.scope ?? (await npmSetting("scope")))) ??
      publishConfiguration?.registry ??
      (await npmSetting("registry"));
    const url = typeof raw === "string" ? URL.parse(raw) : null;
    if (
      !url ||
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      /[?#]/u.test(url.href)
    )
      throw new Error(
        `${name}: npm registry must be an HTTP(S) URL without embedded credentials, query or fragment`,
      );
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.href;
  }

  const registries = new Map();
  for (const entry of PACKAGES) registries.set(entry.name, await resolveRegistry(entry));
  function npmArguments(name, commandArguments) {
    const registry = registries.get(name);
    const scope = packageScope(name);
    // npm gives a scope-specific registry priority even over --registry. Lock both selectors for every operation.
    return [
      "--scope=",
      "--registry=" + registry,
      ...(scope ? [`--${scope}:registry=${registry}`] : []),
      ...commandArguments,
    ];
  }

  if (!dryRun) {
    const authenticated = new Set();
    for (const [name, registry] of registries) {
      if (authenticated.has(registry)) continue;
      const whoami = await session.execute("npm", npmArguments(name, ["whoami"]), {
        encoding: "utf8",
      });
      if (whoami.status !== 0)
        throw new Error(
          "not logged in to the target npm registry; run npm login for that registry first",
        );
      authenticated.add(registry);
      console.log(`  publishing as ${whoami.stdout.trim()}`);
    }
  }

  // Publish-time scanning can exceed fifteen minutes; every visibility query shares this budget.
  const millisecondsPerSecond = 1_000;
  const millisecondsPerMinute = 60_000;
  const registryVisibilityTimeoutMilliseconds = 30 * millisecondsPerMinute;
  const registryPollIntervalMilliseconds = 15 * millisecondsPerSecond;

  // Only an explicit registry miss proves absence; failed observation leaves publication unknown.
  async function registryHasVersion(
    name,
    timeoutMilliseconds = registryVisibilityTimeoutMilliseconds,
  ) {
    const result = await session.execute(
      "npm",
      npmArguments(name, ["view", `${name}@${version}`, "version", "--prefer-online", "--json"]),
      { encoding: "utf8", timeout: timeoutMilliseconds, killSignal: "SIGKILL" },
    );
    const unreadable = (reason) => {
      throw new Error(`Cannot determine whether ${name}@${version} is published: ${reason}`);
    };
    if (result.error) unreadable(result.error.message);
    if (result.signal) unreadable(`npm query terminated by ${result.signal}`);

    let response;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      unreadable("npm query returned invalid JSON");
    }
    if (result.status === 0) {
      if (response !== version) unreadable("npm query returned an unexpected version");
      return true;
    }
    if (response?.error?.code === "E404") return false;
    unreadable(`npm query failed (${response?.error?.code ?? result.status})`);
  }

  // Immutable npm versions permit resume only when uploaded bytes match the intended artifact.
  const alreadyPublished = new Set();
  for (const { name } of PACKAGES) {
    if (await registryHasVersion(name)) alreadyPublished.add(name);
  }
  if ((pendingReleaseCommit || existingTag) && alreadyPublished.size !== PACKAGES.length) {
    throw new Error(
      "Git records this release but not every package is published; refusing to advance it",
    );
  }
  if (alreadyPublished.size) {
    console.log(`  resuming: ${[...alreadyPublished].join(", ")} already at ${version}`);
  } else {
    console.log(`  ${version} is unused on the registry`);
  }

  if (
    !(await session.atSource(source)) ||
    (await session.capture("git", ["status", "--porcelain", "--untracked-files=all"]))
  ) {
    throw new Error("release source changed while checking; refusing to bump manifests");
  }

  step("Bumping versions");

  session.replaceManifests(PACKAGES, source);

  step("Running the full gate (pnpm check) on the release versions");

  const stage = session.createStage();
  await session.run("pnpm", ["check"], { env: { ...process.env, [candidateOutput]: stage } });
  await assertPublicationInputs("accept verified packages");
  const pathsOutsideManifests = [
    ".",
    ...PACKAGES.map(({ directory }) => `:(exclude)${directory}/package.json`),
  ];
  if (
    await session.capture("git", [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ...pathsOutsideManifests,
    ])
  )
    throw new Error("release source changed while checking; refusing to publish");
  const candidates = readVerifiedCandidates(stage);
  const versions = new Map(PACKAGES.map(({ name }) => [name, version]));

  async function assertDistributionTag(name, distributionTag) {
    // Channels can move after a completed release. The remote Git tag owns its historical record.
    if (remoteTag) return;
    const tags = JSON.parse(
      await session.capture(
        "npm",
        npmArguments(name, [
          "view",
          `${name}@${version}`,
          "dist-tags",
          "--prefer-online",
          "--json",
        ]),
      ),
    );
    if (tags?.[distributionTag] !== version)
      throw new Error(
        `${name}@${distributionTag} does not point to ${version}; check the npm channel before resuming`,
      );
  }

  async function verifyRegistryContents(name, candidateFiles) {
    const downloaded = mkdtempSync(join(stage, "registry-"));
    await session.run(
      "npm",
      npmArguments(name, ["pack", `${name}@${version}`, "--pack-destination", downloaded]),
      {
        stdio: "ignore",
      },
    );
    const publishedFiles = readPackageFiles(packageArchiveIn(downloaded));
    rmSync(downloaded, { recursive: true, force: true });
    const file = differingFile(candidateFiles, publishedFiles);
    if (file !== undefined)
      throw new Error(
        `${name}@${version} is published but its ${file} differs from this build; release a new version instead of resuming`,
      );
  }

  function writeCandidate(candidate, directory) {
    const path = join(directory, candidate.filename);
    writeFileSync(path, candidate.bytes, { flag: "wx" });
    return path;
  }

  const packageNameColumnWidth = 22;
  const packageSizeColumnWidth = 7;
  for (const { directory, name, distributionTag, versioned } of PACKAGES) {
    const { files: candidateFiles, bytes } = candidates.get(directory);
    verifyManifest(JSON.parse(versioned), JSON.parse(candidateFiles.get("package.json")), versions);
    if (alreadyPublished.has(name)) {
      await verifyRegistryContents(name, candidateFiles);
      await assertDistributionTag(name, distributionTag);
      console.log(
        `  ${name.padEnd(packageNameColumnWidth)} ${"skip".padStart(packageSizeColumnWidth)}     already published, contents match`,
      );
      continue;
    }

    const size = (bytes.byteLength / 1024).toFixed(1);
    console.log(
      `  ${name.padEnd(packageNameColumnWidth)} ${size.padStart(packageSizeColumnWidth)} KB  ${version} (--tag=${distributionTag})`,
    );
  }

  if (dryRun) {
    if (!(await session.restoreManifests()))
      throw new Error("Checkout moved; inspect manifests before resuming");
    session.retainStage();
    step("Dry run complete");
    console.log("  every check passed; no package was published, tagged or pushed");
    console.log(`  tarballs kept at ${stage}`);
    console.log("  package.json versions restored\n");
    return;
  }

  if (!assumeYes) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      answer = await prompt.question(
        `\nPublish ${PACKAGES.length} packages at ${version}? [y/N] `,
        { signal: session.signal },
      );
    } finally {
      prompt.close();
    }
    if (answer.trim().toLowerCase() !== "y") {
      if (!(await session.restoreManifests()))
        throw new Error("aborted; checkout moved, inspect manifests before resuming");
      throw new Error("aborted; package.json versions restored");
    }
  }

  // Publish inspected tarballs so verified bytes are the uploaded bytes; confirm registry presence and contents before recording success.

  step("Publishing");

  console.log(
    "  If two-factor authentication is enabled, npm prints a URL and waits for\n" +
      "  browser approval. Nothing is published until you complete it.\n" +
      "  Pass --otp=<code> instead to authorize from the terminal.\n",
  );

  // Await registry visibility before publishing dependents because successful uploads can remain temporarily unreadable.
  async function waitForRegistryVisibility(name) {
    const deadline = performance.now() + registryVisibilityTimeoutMilliseconds;
    let announced = false;
    while (true) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) return false;
      const visible = await registryHasVersion(name, remaining);
      if (performance.now() > deadline) return false;
      if (visible) return true;
      if (!announced) {
        console.log(`  waiting for ${name}@${version} to become readable...`);
        announced = true;
      }
      const remainingAfterQuery = Math.floor(deadline - performance.now());
      if (remainingAfterQuery <= 0) return false;
      await delay(Math.min(registryPollIntervalMilliseconds, remainingAfterQuery), undefined, {
        signal: session.signal,
      });
    }
  }

  async function assertPublicationInputs(action) {
    if (!(await session.atSource(source)))
      throw new Error(`release source changed during publication; refusing to ${action}`);
    for (const { directory, versioned } of PACKAGES) {
      if (!readFileSync(manifestPath(directory)).equals(versioned)) {
        throw new Error(`${directory}/package.json changed during release; refusing to ${action}`);
      }
    }
  }

  // Registry uploads cannot be rolled back if the verified branch or release tag changed while waiting.
  async function assertRemoteReleaseReferences() {
    if ((await releaseReferences()).join("\n") !== verifiedReferences.join("\n")) {
      throw new Error("remote release refs changed since preflight; refusing to publish");
    }
  }

  const published = [];
  for (const { directory, name, distributionTag } of PACKAGES) {
    if (alreadyPublished.has(name)) {
      console.log(`  · ${name}@${version} already published, skipped`);
      continue;
    }
    await assertPublicationInputs("publish " + name);
    const candidate = candidates.get(directory);
    const upload = writeCandidate(candidate, mkdtempSync(join(stage, "upload-")));
    const publishArguments = ["publish", upload, "--access", "public", `--tag=${distributionTag}`];
    if (oneTimePassword !== undefined) publishArguments.push(`--otp=${oneTimePassword}`);
    await assertRemoteReleaseReferences();
    const result = await session.execute("npm", npmArguments(name, publishArguments), {
      stdio: "inherit",
    });
    if (result.status === 0 && !(await waitForRegistryVisibility(name))) {
      if (published.length) console.error(`  Already published: ${published.join(", ")}`);
      console.error(`  Re-running \`${resumeCommand}\` resumes from here.`);
      throw new Error(
        `${name}: npm accepted ${version}, but it was not readable within ${registryVisibilityTimeoutMilliseconds / millisecondsPerMinute} minutes; processing may still be pending.`,
      );
    }
    if (result.status !== 0) {
      if (published.length) {
        console.error(`  Already on the registry: ${published.join(", ")}`);
      }
      console.error(`  Fix the cause and re-run \`${resumeCommand}\`; it resumes from here.`);
      throw new Error(`${name} failed to publish.`, { cause: result.error });
    }
    await verifyRegistryContents(name, candidate.files);
    await assertDistributionTag(name, distributionTag);
    published.push(name);
    console.log(`  ✓ ${name}@${version}`);
  }

  // Record the release only after every registry upload is confirmed so tags cannot imply partial publication.

  step("Recording the release");

  // Waiting for uploads or approval can outlive an earlier channel observation.
  for (const { name, distributionTag } of PACKAGES)
    await assertDistributionTag(name, distributionTag);
  await assertPublicationInputs("record");
  const staged = await session.execute(
    "git",
    ["diff", "--cached", "--quiet", head, "--", ...manifestFiles],
    {
      stdio: "inherit",
    },
  );
  if (staged.error || staged.status !== 0)
    throw new Error(
      "release manifests have staged changes or the index is unreadable; refusing to replace them",
    );

  let releaseCommit = head;
  // Git's clean filters decide whether worktree bytes represent a different tree.
  const changed = await session.execute("git", ["diff", "--quiet", head, "--", ...manifestFiles], {
    stdio: "inherit",
  });
  if (changed.error || (changed.status !== 0 && changed.status !== 1))
    throw new Error("Cannot determine whether release manifests change the Git tree");
  if (changed.status === 1) {
    // Git's path-scoped commit leaves other owners' staged files outside the release.
    await session.run("git", [
      "commit",
      "--only",
      "-m",
      `chore: release ${version}`,
      "--",
      ...manifestFiles,
    ]);
    releaseCommit = await session.capture("git", ["rev-parse", "HEAD"]);
    if (!(await isReleaseCommit(releaseCommit, head)))
      throw new Error("Git commit differs from the verified release; refusing to tag or push");
  }
  session.recordManifests();
  if (!existingTag)
    await session.run("git", ["tag", "-a", tag, releaseCommit, "-m", `Dougong ${version}`]);
  const tagObject = existingTag ?? (await session.capture("git", ["rev-parse", tagReference]));
  if (
    (await session.capture("git", ["cat-file", "-t", tagObject])) !== "tag" ||
    (await session.capture("git", ["rev-parse", `${tagObject}^{commit}`])) !== releaseCommit
  )
    throw new Error(`tag ${tag} does not record the verified release; refusing to push`);
  // Pin both sides: a plain fast-forward push can recreate a branch somebody just deleted.
  await assertReleaseDestination();
  const push = await session.execute(
    "git",
    [
      ...releaseRemoteConfiguration,
      "push",
      "--atomic",
      "--no-follow-tags",
      `--force-with-lease=${mainReference}:${remoteMain}`,
      `--force-with-lease=${tagReference}:${remoteTag.split("\t")[0]}`,
      "--",
      releaseRemote,
      `${releaseCommit}:${mainReference}`,
      `${tagObject}:${tagReference}`,
    ],
    { stdio: "inherit" },
  );
  if (push.error) throw new Error(`git push could not start: ${push.error.message}`);
  // The command-scoped remote owns no tracking refs. Only a fetch observes what origin's read endpoint now holds.
  const refresh = await session.execute(
    "git",
    ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", "main"],
    {
      stdio: "inherit",
    },
  );
  if (push.status !== 0)
    throw new Error(
      `Git did not confirm the atomic push. Re-run \`${resumeCommand}\` to inspect the remote state and resume.`,
    );
  if (refresh.status !== 0)
    console.warn("Release pushed; fetch origin to refresh local tracking refs.");

  console.log(`\n[32m✓ Dougong ${version} released[0m`);
  for (const { name } of PACKAGES) console.log(`    ${name}@${version} (${registries.get(name)})`);
  console.log();
}

const session = new ReleaseSession();
try {
  await release(session);
} catch (error) {
  if (error !== session.signal.reason) console.error(error);
  process.exitCode = 1;
} finally {
  await session.close();
}
