#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { prerelease, valid, validRange } from "semver";
import { packageArchiveIn, readPackageFiles } from "../package-archive.mjs";
import { packageName, publishedDirectories } from "../packages.mjs";
import {
  candidateOutput,
  differingFile,
  readVerifiedCandidates,
  verifyManifest,
} from "../consumer/package-candidates.mjs";

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function step(message) {
  console.log(`\n[1m▸ ${message}[0m`);
}

function run(command, commandArguments, options = {}) {
  const result = spawnSync(command, commandArguments, { stdio: "inherit", ...options });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${commandArguments[0]} exited with ${result.status}`);
  }
  return result;
}

function capture(command, commandArguments, options = {}) {
  return run(command, commandArguments, {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    ...options,
  }).stdout.trim();
}

function manifestPath(directory) {
  if (
    !lstatSync(directory).isDirectory() ||
    realpathSync(directory) !== join(realpathSync("."), directory)
  ) {
    throw new Error(`Package root must be a directory inside this workspace: ${directory}`);
  }
  const file = resolve(directory, "package.json");
  if (!lstatSync(file).isFile())
    throw new Error(`Release manifest must be a regular file: ${file}`);
  return file;
}

function versionedManifest(contents) {
  const manifest = JSON.parse(contents);
  manifest.version = version;
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

function replaceManifest(directory, expected, replacement, onReplaced) {
  const path = manifestPath(directory);
  const temporary = mkdtempSync(join(dirname(path), ".release-manifest-"));
  try {
    const file = join(temporary, "package.json");
    writeFileSync(file, replacement);
    chmodSync(file, statSync(path).mode);
    if (!readFileSync(manifestPath(directory)).equals(expected)) {
      throw new Error(
        `${directory}/package.json changed during release; preserving external edits`,
      );
    }
    renameSync(file, path);
    onReplaced?.();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

let input;
try {
  input = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      yes: { type: "boolean" },
      otp: { type: "string" },
      tag: { type: "string" },
    },
    allowPositionals: true,
    tokens: true,
  });
} catch (error) {
  fail(error.message);
}
const { values, positionals, tokens } = input;
if (positionals.length !== 1) {
  fail(
    "usage: node tooling/release/release.mjs <version> [--dry-run] [--yes] [--tag=<dist-tag>] [--otp=<code>]",
  );
}
const seenOptions = new Set();
for (const token of tokens) {
  if (token.kind !== "option") continue;
  if (seenOptions.has(token.name)) fail(`Option '--${token.name}' must be specified once`);
  seenOptions.add(token.name);
}
const [version] = positionals;
if (valid(version) !== version) {
  fail(`'${version}' is not a canonical semantic version`);
}
const dryRun = values["dry-run"] === true;
const assumeYes = values.yes === true;
const oneTimePassword = values.otp;
if (oneTimePassword !== undefined && !oneTimePassword.trim())
  fail("--otp must be a non-empty code");

const PACKAGES = publishedDirectories.map((directory) => {
  const original = readFileSync(manifestPath(directory));
  const manifest = JSON.parse(original);
  const name = packageName(manifest.name);
  const distributionTag = values.tag === undefined ? manifest.publishConfig?.tag : values.tag;
  if (distributionTag === undefined && prerelease(version))
    fail(`${name}: a prerelease needs --tag=<dist-tag> or publishConfig.tag`);
  if (
    distributionTag !== undefined &&
    (typeof distributionTag !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(distributionTag) ||
      validRange(distributionTag) !== null)
  )
    fail(`${name}: invalid npm dist-tag; use a channel name such as next or beta`);
  return {
    directory,
    name,
    distributionTag,
    publishConfig: manifest.publishConfig,
    currentVersion: manifest.version,
    original,
    versioned: versionedManifest(original),
  };
});
if (new Set(PACKAGES.map(({ name }) => name)).size !== PACKAGES.length)
  fail("Release package names must be unique");
const resumeCommand = `pnpm release ${version}${values.tag === undefined ? "" : ` --tag=${values.tag}`}`;
const manifestFiles = PACKAGES.map(({ directory }) => manifestPath(directory));

const current = PACKAGES[0].currentVersion;
console.log(`\nDougong release: ${current} → ${version}${dryRun ? "  (dry run)" : ""}`);

// Publish only reproducible source states so recovery cannot include unrelated commits.

step("Verifying repository state");

const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") fail(`on branch '${branch}'; releases are cut from main`);

if (capture("git", ["status", "--porcelain", "--untracked-files=all"])) {
  fail("working tree is not clean; commit or stash first");
}

run("git", ["fetch", "--quiet", "origin", "main"]);
const remoteMain = capture("git", ["rev-parse", "FETCH_HEAD^{commit}"]);
const ahead = capture("git", ["rev-list", "--count", remoteMain + "..HEAD"]);
const behind = capture("git", ["rev-list", "--count", "HEAD.." + remoteMain]);
if (behind !== "0") fail(`local main is ${behind} commit(s) behind origin/main`);

// Git owns the release record; a separate recovery marker could disagree with the actual commit.
function isReleaseCommit(commit, parent) {
  if (capture("git", ["show", "-s", "--format=%B", commit]) !== `chore: release ${version}`) {
    return false;
  }
  if (capture("git", ["rev-list", "--parents", "-n", "1", commit]) !== `${commit} ${parent}`) {
    return false;
  }
  if (capture("git", ["diff", "--summary", parent, commit])) return false;
  const changed = capture("git", ["diff", "--name-only", parent, commit]).split("\n");
  if (
    changed.some((file) => !PACKAGES.some(({ directory }) => file === `${directory}/package.json`))
  ) {
    return false;
  }
  return PACKAGES.every(({ directory }) => {
    const before = execFileSync("git", ["show", `${parent}:${directory}/package.json`]);
    const after = execFileSync("git", ["show", `${commit}:${directory}/package.json`]);
    return after.equals(versionedManifest(before));
  });
}

const head = capture("git", ["rev-parse", "HEAD"]);
const pendingReleaseCommit = ahead === "1" && isReleaseCommit(head, remoteMain);
if (ahead !== "0" && !pendingReleaseCommit) {
  fail(`local main is ${ahead} commit(s) ahead of origin/main; push first`);
}

const tag = `v${version}`;
const mainReference = "refs/heads/main";
const tagReference = `refs/tags/${tag}`;
const existingTag = capture("git", ["tag", "--list", tag])
  ? capture("git", ["rev-parse", tagReference])
  : undefined;
if (
  existingTag &&
  (!PACKAGES.every(({ currentVersion }) => currentVersion === version) ||
    capture("git", ["cat-file", "-t", existingTag]) !== "tag" ||
    capture("git", ["rev-parse", `${existingTag}^{commit}`]) !== head)
) {
  fail(`tag ${tag} already exists but does not record this release`);
}
// A push URL can differ from the fetch URL; several push destinations cannot share an atomic release.
const destinations = run("git", ["remote", "get-url", "--push", "--all", "origin"], {
  stdio: ["ignore", "pipe", "inherit"],
  encoding: "utf8",
})
  .stdout.replace(/\r?\n$/u, "")
  .split(/\r?\n/u);
if (destinations.length !== 1 || !destinations[0]) fail("origin must have one push destination");
const [destination] = destinations;
const configuredRemotes = new Set(capture("git", ["remote"]).split("\n"));
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
function assertReleaseDestination() {
  // Command-scoped remotes support this local lookup; remote get-url requires a persisted remote.
  const observed = run(
    "git",
    [...releaseRemoteConfiguration, "ls-remote", "--get-url", releaseRemote],
    { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" },
  ).stdout.replace(/\r?\n$/u, "");
  if (observed !== destination)
    fail("Git release destination would be rewritten; refusing to publish");
}
function releaseReferences() {
  assertReleaseDestination();
  return capture("git", [
    ...releaseRemoteConfiguration,
    "ls-remote",
    "--refs",
    "--",
    releaseRemote,
    mainReference,
    tagReference,
  ])
    .split("\n")
    .filter(Boolean)
    .sort();
}
const verifiedReferences = releaseReferences();
if (!verifiedReferences.includes(remoteMain + "\t" + mainReference))
  fail("origin push destination main differs from the fetched source; refusing to publish");
const remoteTag = verifiedReferences.find((line) => line.endsWith("\t" + tagReference)) ?? "";
if (remoteTag && remoteTag !== existingTag + "\t" + tagReference)
  fail(`origin already has a different release tag ${tag}; inspect it before publishing`);
console.log(
  `  main is clean${pendingReleaseCommit ? "; resuming its release record" : " and equals origin/main"} at ${head}`,
);

step("Verifying registry state");

for (const { directory, original } of PACKAGES) {
  if (!readFileSync(manifestPath(directory)).equals(original))
    fail(`${directory}/package.json changed since release input capture`);
}

const npmSettings = new Map();
function npmSetting(key) {
  if (!npmSettings.has(key)) {
    const value = capture("npm", ["config", "get", key], { stdio: ["ignore", "pipe", "ignore"] });
    npmSettings.set(key, value === "undefined" || !value ? undefined : value);
  }
  return npmSettings.get(key);
}

function packageScope(name) {
  return name.startsWith("@") ? name.split("/")[0] : undefined;
}

function resolveRegistry({ name, publishConfig }) {
  const scope = packageScope(name);
  const scoped = (scopeName) => {
    if (!scopeName) return undefined;
    if (typeof scopeName !== "string" || !/^@?[^@:/\s]+$/u.test(scopeName))
      fail(`${name}: invalid npm registry scope`);
    const key = scopeName.replace(/^@?/u, "@") + ":registry";
    return publishConfig?.[key] ?? npmSetting(key);
  };
  const raw =
    scoped(scope) ??
    scoped(publishConfig?.scope ?? npmSetting("scope")) ??
    publishConfig?.registry ??
    npmSetting("registry");
  const url = typeof raw === "string" ? URL.parse(raw) : null;
  if (
    !url ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    /[?#]/u.test(url.href)
  )
    fail(
      `${name}: npm registry must be an HTTP(S) URL without embedded credentials, query or fragment`,
    );
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

const registries = new Map(PACKAGES.map((entry) => [entry.name, resolveRegistry(entry)]));
function npmArguments(name, args) {
  const registry = registries.get(name);
  const scope = packageScope(name);
  // npm gives a scope-specific registry priority even over --registry. Lock both selectors for every operation.
  return [
    "--scope=",
    "--registry=" + registry,
    ...(scope ? [`--${scope}:registry=${registry}`] : []),
    ...args,
  ];
}

if (!dryRun) {
  const authenticated = new Set();
  for (const [name, registry] of registries) {
    if (authenticated.has(registry)) continue;
    const whoami = spawnSync("npm", npmArguments(name, ["whoami"]), { encoding: "utf8" });
    if (whoami.status !== 0)
      fail("not logged in to the target npm registry; run npm login for that registry first");
    authenticated.add(registry);
    console.log(`  publishing as ${whoami.stdout.trim()}`);
  }
}

// Only an explicit registry miss proves absence; failed observation leaves publication unknown.
function registryHasVersion(name) {
  const result = spawnSync(
    "npm",
    npmArguments(name, ["view", `${name}@${version}`, "version", "--prefer-online", "--json"]),
    { encoding: "utf8" },
  );
  const unreadable = (reason) =>
    fail(`Cannot determine whether ${name}@${version} is published: ${reason}`);
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
  if (registryHasVersion(name)) alreadyPublished.add(name);
}
if ((pendingReleaseCommit || existingTag) && alreadyPublished.size !== PACKAGES.length) {
  fail("Git records this release but not every package is published; refusing to advance it");
}
if (alreadyPublished.size) {
  console.log(`  resuming: ${[...alreadyPublished].join(", ")} already at ${version}`);
} else {
  console.log(`  ${version} is unused on the registry`);
}

function atReleaseSource() {
  return (
    capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]) === branch &&
    capture("git", ["rev-parse", "HEAD"]) === head
  );
}

if (!atReleaseSource() || capture("git", ["status", "--porcelain", "--untracked-files=all"])) {
  fail("release source changed while checking; refusing to bump manifests");
}

step("Bumping versions");

// Rollback owns an entry only once the atomic replacement succeeded.
const replacedManifests = new Set();

function restoreManifests() {
  const owned = [...replacedManifests];
  replacedManifests.clear();
  if (!atReleaseSource()) return false;

  const errors = [];
  for (const { directory, original, versioned } of owned) {
    try {
      if (!readFileSync(manifestPath(directory)).equals(original)) {
        replaceManifest(directory, versioned, original);
      }
    } catch (cause) {
      errors.push(new Error(`Could not restore ${directory}/package.json`, { cause }));
    }
  }
  if (errors.length) throw new AggregateError(errors, "Release manifest restoration failed");
  return true;
}

process.on("exit", (code) => {
  if (code !== 0 && replacedManifests.size) {
    try {
      if (!restoreManifests())
        console.error("Checkout moved; leaving manifests untouched. Inspect Git before resuming.");
    } catch (error) {
      console.error(error);
    }
  }
});

// Signals bypass the exit hook, so interrupted releases need their own restoration path.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (replacedManifests.size) {
      try {
        const restored = restoreManifests();
        console.error(
          restored
            ? "\n  interrupted — package.json versions restored"
            : `\n  interrupted — checkout moved; manifests left untouched, inspect Git before resuming`,
        );
      } catch (error) {
        console.error(error);
      }
    }
    process.exit(130);
  });
}

for (const entry of PACKAGES) {
  replaceManifest(entry.directory, entry.original, entry.versioned, () =>
    replacedManifests.add(entry),
  );
  console.log(`  ${entry.name} → ${version}`);
}

step("Running the full gate (pnpm check) on the release versions");

const stage = mkdtempSync(join(tmpdir(), "dougong-release-"));
let keepStage = false;
process.once("exit", () => {
  if (!keepStage) rmSync(stage, { recursive: true, force: true });
});
run("pnpm", ["check"], { env: { ...process.env, [candidateOutput]: stage } });
assertPublicationInputs("accept verified packages");
const pathsOutsideManifests = [
  ".",
  ...PACKAGES.map(({ directory }) => `:(exclude)${directory}/package.json`),
];
if (
  capture("git", ["status", "--porcelain", "--untracked-files=all", "--", ...pathsOutsideManifests])
)
  fail("release source changed while checking; refusing to publish");
const candidates = readVerifiedCandidates(stage);
const versions = new Map(PACKAGES.map(({ name }) => [name, version]));

function assertDistributionTag(name, distributionTag) {
  // Channels can move after a completed release. The remote Git tag owns its historical record.
  if (distributionTag === undefined || remoteTag) return;
  const tags = JSON.parse(
    capture(
      "npm",
      npmArguments(name, ["view", `${name}@${version}`, "dist-tags", "--prefer-online", "--json"]),
    ),
  );
  if (tags?.[distributionTag] !== version)
    fail(
      `${name}@${distributionTag} does not point to ${version}; check the npm channel before resuming`,
    );
}

function verifyRegistryContents(name, candidateFiles) {
  const downloaded = mkdtempSync(join(stage, "registry-"));
  execFileSync(
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
    fail(
      `${name}@${version} is published but its ${file} differs from this build; release a new version instead of resuming`,
    );
}

function writeCandidate(candidate, directory) {
  const path = join(directory, candidate.filename);
  writeFileSync(path, candidate.bytes, { flag: "wx" });
  return path;
}

for (const { directory, name, distributionTag, versioned } of PACKAGES) {
  const { files: candidateFiles, bytes } = candidates.get(directory);
  verifyManifest(JSON.parse(versioned), JSON.parse(candidateFiles.get("package.json")), versions);
  if (alreadyPublished.has(name)) {
    verifyRegistryContents(name, candidateFiles);
    assertDistributionTag(name, distributionTag);
    console.log(`  ${name.padEnd(22)} ${"skip".padStart(7)}     already published, contents match`);
    continue;
  }

  const size = (bytes.byteLength / 1024).toFixed(1);
  console.log(
    `  ${name.padEnd(22)} ${size.padStart(7)} KB  ${version}${distributionTag ? ` (--tag=${distributionTag})` : ""}`,
  );
}

if (dryRun) {
  if (!restoreManifests()) fail("Checkout moved; inspect manifests before resuming");
  keepStage = true;
  step("Dry run complete");
  console.log("  every check passed; no package was published, tagged or pushed");
  console.log(`  tarballs kept at ${stage}`);
  console.log("  package.json versions restored\n");
  process.exit(0);
}

if (!assumeYes) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(
    `\nPublish ${PACKAGES.length} packages at ${version}? [y/N] `,
  );
  prompt.close();
  if (answer.trim().toLowerCase() !== "y") {
    if (!restoreManifests()) fail("aborted; checkout moved, inspect manifests before resuming");
    fail("aborted; package.json versions restored");
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
function awaitRegistry(name) {
  // Publish-time scanning can exceed fifteen minutes; the visibility timeout must cover that delay.
  for (let attempt = 0; attempt < 120; attempt++) {
    if (registryHasVersion(name)) return true;
    if (attempt === 0) console.log(`  waiting for ${name}@${version} to become readable...`);
    execFileSync("sleep", ["15"]);
  }
  return false;
}

function assertPublicationInputs(action) {
  if (!atReleaseSource()) fail(`release source changed during publication; refusing to ${action}`);
  for (const { directory, versioned } of PACKAGES) {
    if (!readFileSync(manifestPath(directory)).equals(versioned)) {
      fail(`${directory}/package.json changed during release; refusing to ${action}`);
    }
  }
}

// Registry uploads cannot be rolled back if the verified branch or release tag changed while waiting.
function assertRemoteReleaseReferences() {
  if (releaseReferences().join("\n") !== verifiedReferences.join("\n")) {
    fail("remote release refs changed since preflight; refusing to publish");
  }
}

const published = [];
for (const { directory, name, distributionTag } of PACKAGES) {
  if (alreadyPublished.has(name)) {
    console.log(`  · ${name}@${version} already published, skipped`);
    continue;
  }
  assertPublicationInputs("publish " + name);
  const candidate = candidates.get(directory);
  const upload = writeCandidate(candidate, mkdtempSync(join(stage, "upload-")));
  const publishArguments = ["publish", upload, "--access", "public"];
  if (distributionTag !== undefined) publishArguments.push(`--tag=${distributionTag}`);
  if (oneTimePassword !== undefined) publishArguments.push(`--otp=${oneTimePassword}`);
  assertRemoteReleaseReferences();
  const result = spawnSync("npm", npmArguments(name, publishArguments), { stdio: "inherit" });
  if (result.status === 0 && !awaitRegistry(name)) {
    console.error(
      `\n✗ ${name}: npm accepted ${version}, but it was not readable within 30 minutes; processing may still be pending.`,
    );
    if (published.length) console.error(`  Already published: ${published.join(", ")}`);
    console.error(`  Re-running \`${resumeCommand}\` resumes from here.`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n✗ ${name} failed to publish.`);
    if (published.length) {
      console.error(`  Already on the registry: ${published.join(", ")}`);
    }
    console.error(`  Fix the cause and re-run \`${resumeCommand}\`; it resumes from here.`);
    process.exit(1);
  }
  verifyRegistryContents(name, candidate.files);
  assertDistributionTag(name, distributionTag);
  published.push(name);
  console.log(`  ✓ ${name}@${version}`);
}

// Record the release only after every registry upload is confirmed so tags cannot imply partial publication.

step("Recording the release");

// Waiting for uploads or approval can outlive an earlier channel observation.
for (const { name, distributionTag } of PACKAGES) assertDistributionTag(name, distributionTag);
assertPublicationInputs("record");
const staged = spawnSync("git", ["diff", "--cached", "--quiet", head, "--", ...manifestFiles], {
  stdio: "inherit",
});
if (staged.error || staged.status !== 0)
  fail(
    "release manifests have staged changes or the index is unreadable; refusing to replace them",
  );

let releaseCommit = head;
// Git's clean filters decide whether worktree bytes represent a different tree.
const changed = spawnSync("git", ["diff", "--quiet", head, "--", ...manifestFiles], {
  stdio: "inherit",
});
if (changed.error || (changed.status !== 0 && changed.status !== 1))
  fail("Cannot determine whether release manifests change the Git tree");
if (changed.status === 1) {
  // Git's path-scoped commit leaves other owners' staged files outside the release.
  run("git", ["commit", "--only", "-m", `chore: release ${version}`, "--", ...manifestFiles]);
  releaseCommit = capture("git", ["rev-parse", "HEAD"]);
  if (!isReleaseCommit(releaseCommit, head))
    fail("Git commit differs from the verified release; refusing to tag or push");
}
replacedManifests.clear();
if (!existingTag) run("git", ["tag", "-a", tag, releaseCommit, "-m", `Dougong ${version}`]);
const tagObject = existingTag ?? capture("git", ["rev-parse", tagReference]);
if (
  capture("git", ["cat-file", "-t", tagObject]) !== "tag" ||
  capture("git", ["rev-parse", `${tagObject}^{commit}`]) !== releaseCommit
)
  fail(`tag ${tag} does not record the verified release; refusing to push`);
// Pin both sides: a plain fast-forward push can recreate a branch somebody just deleted.
assertReleaseDestination();
const push = spawnSync(
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
if (push.error) fail(`git push could not start: ${push.error.message}`);
// The command-scoped remote owns no tracking refs. Only a fetch observes what origin's read endpoint now holds.
const refresh = spawnSync(
  "git",
  ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", "main"],
  {
    stdio: "inherit",
  },
);
if (push.status !== 0)
  fail(
    `Git did not confirm the atomic push. Re-run \`${resumeCommand}\` to inspect the remote state and resume.`,
  );
if (refresh.status !== 0)
  console.warn("Release pushed; fetch origin to refresh local tracking refs.");

console.log(`\n[32m✓ Dougong ${version} released[0m`);
for (const { name } of PACKAGES) console.log(`    ${name}@${version} (${registries.get(name)})`);
console.log();
