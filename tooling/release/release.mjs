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
import { valid } from "semver";
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

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", ...options });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${commandArgs.join(" ")} exited with ${result.status}`);
  }
}

function capture(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { encoding: "utf8", ...options }).trim();
}

function manifestPath(dir) {
  if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== join(realpathSync("."), dir)) {
    throw new Error(`Package root must be a directory inside this workspace: ${dir}`);
  }
  const file = resolve(dir, "package.json");
  if (!lstatSync(file).isFile())
    throw new Error(`Release manifest must be a regular file: ${file}`);
  return file;
}

function readManifest(dir) {
  return JSON.parse(readFileSync(manifestPath(dir), "utf8"));
}

function versionedManifest(contents) {
  const manifest = JSON.parse(contents);
  manifest.version = version;
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

function replaceManifest(dir, expected, replacement) {
  const path = manifestPath(dir);
  const temporary = mkdtempSync(join(dirname(path), ".release-manifest-"));
  try {
    const file = join(temporary, "package.json");
    writeFileSync(file, replacement);
    chmodSync(file, statSync(path).mode);
    if (!readFileSync(manifestPath(dir)).equals(expected)) {
      throw new Error(`${dir}/package.json changed during release; preserving external edits`);
    }
    renameSync(file, path);
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
    },
    allowPositionals: true,
    tokens: true,
  });
} catch (error) {
  fail(error.message);
}
const { values, positionals, tokens } = input;
if (positionals.length !== 1) {
  fail("usage: node tooling/release/release.mjs <version> [--dry-run] [--yes] [--otp=<code>]");
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
const otp = values.otp;
if (otp !== undefined && !otp.trim()) fail("--otp must be a non-empty code");

const PACKAGES = publishedDirectories.map((dir) => {
  return { dir, name: packageName(readManifest(dir).name) };
});
if (new Set(PACKAGES.map(({ name }) => name)).size !== PACKAGES.length)
  fail("Release package names must be unique");
const manifestFiles = PACKAGES.map(({ dir }) => manifestPath(dir));

const current = readManifest(PACKAGES[0].dir).version;
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
  if (changed.some((file) => !PACKAGES.some(({ dir }) => file === `${dir}/package.json`))) {
    return false;
  }
  return PACKAGES.every(({ dir }) => {
    const before = execFileSync("git", ["show", `${parent}:${dir}/package.json`]);
    const after = execFileSync("git", ["show", `${commit}:${dir}/package.json`]);
    return after.equals(versionedManifest(before));
  });
}

const head = capture("git", ["rev-parse", "HEAD"]);
const pendingReleaseCommit = ahead === "1" && isReleaseCommit(head, remoteMain);
if (ahead !== "0" && !pendingReleaseCommit) {
  fail(`local main is ${ahead} commit(s) ahead of origin/main; push first`);
}

const tag = `v${version}`;
const mainRef = "refs/heads/main";
const tagRef = `refs/tags/${tag}`;
const existingTag = capture("git", ["tag", "--list", tag])
  ? capture("git", ["rev-parse", tagRef])
  : undefined;
if (
  existingTag &&
  (!PACKAGES.every(({ dir }) => readManifest(dir).version === version) ||
    capture("git", ["cat-file", "-t", existingTag]) !== "tag" ||
    capture("git", ["rev-parse", `${existingTag}^{commit}`]) !== head)
) {
  fail(`tag ${tag} already exists but does not record this release`);
}
// Fetching main need not fetch its tags. A remote reservation must be checked before the first upload.
const remoteTag = capture("git", ["ls-remote", "--refs", "origin", tagRef]);
if (remoteTag && remoteTag !== existingTag + "\t" + tagRef)
  fail(`origin already has a different release tag ${tag}; inspect it before publishing`);
console.log(
  `  main is clean${pendingReleaseCommit ? "; resuming its release record" : " and equals origin/main"} at ${head}`,
);

step("Verifying registry state");

if (!dryRun) {
  const whoami = spawnSync("npm", ["whoami"], { encoding: "utf8" });
  if (whoami.status !== 0) fail("not logged in to npm; run `npm login` first");
  console.log(`  publishing as ${whoami.stdout.trim()}`);
}

// Only an explicit registry miss proves absence; failed observation leaves publication unknown.
function registryHasVersion(name) {
  const result = spawnSync(
    "npm",
    ["view", `${name}@${version}`, "version", "--prefer-online", "--json"],
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

// Capture all originals before writing so a partial write can restore every manifest.
const originalManifests = new Map(
  PACKAGES.map(({ dir }) => [dir, readFileSync(manifestPath(dir))]),
);

function restoreManifests() {
  const originals = [...originalManifests];
  originalManifests.clear();
  if (!atReleaseSource()) return false;

  const errors = [];
  for (const [dir, contents] of originals) {
    try {
      if (!readFileSync(manifestPath(dir)).equals(contents)) {
        replaceManifest(dir, versionedManifest(contents), contents);
      }
    } catch (cause) {
      errors.push(new Error(`Could not restore ${dir}/package.json`, { cause }));
    }
  }
  if (errors.length) throw new AggregateError(errors, "Release manifest restoration failed");
  return true;
}

process.on("exit", (code) => {
  if (code !== 0 && originalManifests.size) {
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
    if (originalManifests.size) {
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

for (const { dir, name } of PACKAGES) {
  const original = originalManifests.get(dir);
  replaceManifest(dir, original, versionedManifest(original));
  console.log(`  ${name} → ${version}`);
}

step("Running the full gate (pnpm check) on the release versions");

const stage = mkdtempSync(join(tmpdir(), "dougong-release-"));
let keepStage = false;
process.once("exit", () => {
  if (!keepStage) rmSync(stage, { recursive: true, force: true });
});
run("pnpm", ["check"], { env: { ...process.env, [candidateOutput]: stage } });
assertPublicationInputs("accept verified packages");
const pathsOutsideManifests = [".", ...PACKAGES.map(({ dir }) => `:(exclude)${dir}/package.json`)];
if (
  capture("git", ["status", "--porcelain", "--untracked-files=all", "--", ...pathsOutsideManifests])
)
  fail("release source changed while checking; refusing to publish");
const candidates = readVerifiedCandidates(stage);
const versions = new Map(PACKAGES.map(({ name }) => [name, version]));

function verifyRegistryContents(name, candidateFiles) {
  const downloaded = mkdtempSync(join(stage, "registry-"));
  execFileSync("npm", ["pack", `${name}@${version}`, "--pack-destination", downloaded], {
    stdio: "ignore",
  });
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

for (const { dir, name } of PACKAGES) {
  const { files: candidateFiles, bytes } = candidates.get(dir);
  verifyManifest(
    JSON.parse(versionedManifest(originalManifests.get(dir))),
    JSON.parse(candidateFiles.get("package.json")),
    versions,
  );
  if (alreadyPublished.has(name)) {
    verifyRegistryContents(name, candidateFiles);
    console.log(`  ${name.padEnd(22)} ${"skip".padStart(7)}     already published, contents match`);
    continue;
  }

  const size = (bytes.byteLength / 1024).toFixed(1);
  console.log(`  ${name.padEnd(22)} ${size.padStart(7)} KB  ${version}`);
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
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nPublish ${PACKAGES.length} packages at ${version}? [y/N] `);
  rl.close();
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
  for (const [dir, contents] of originalManifests) {
    if (!readFileSync(manifestPath(dir)).equals(versionedManifest(contents))) {
      fail(`${dir}/package.json changed during release; refusing to ${action}`);
    }
  }
}

// Registry uploads cannot be rolled back if the verified branch or release tag changed while waiting.
const verifiedRefs = [remoteMain + "\t" + mainRef, remoteTag].filter(Boolean).sort().join("\n");
function assertRemoteReleaseRefs() {
  const observed = capture("git", ["ls-remote", "--refs", "origin", mainRef, tagRef]);
  if (observed.split("\n").sort().join("\n") !== verifiedRefs) {
    fail("remote release refs changed since preflight; refusing to publish");
  }
}

const published = [];
for (const { dir, name } of PACKAGES) {
  if (alreadyPublished.has(name)) {
    console.log(`  · ${name}@${version} already published, skipped`);
    continue;
  }
  assertPublicationInputs("publish " + name);
  const candidate = candidates.get(dir);
  const upload = writeCandidate(candidate, mkdtempSync(join(stage, "upload-")));
  const publishArgs = ["publish", upload, "--access", "public"];
  if (otp !== undefined) publishArgs.push(`--otp=${otp}`);
  assertRemoteReleaseRefs();
  const result = spawnSync("npm", publishArgs, { stdio: "inherit" });
  if (result.status === 0 && !awaitRegistry(name)) {
    console.error(
      `\n✗ ${name}: npm accepted ${version}, but it was not readable within 30 minutes; processing may still be pending.`,
    );
    if (published.length) console.error(`  Already published: ${published.join(", ")}`);
    console.error(`  Re-running \`pnpm release ${version}\` resumes from here.`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n✗ ${name} failed to publish.`);
    if (published.length) {
      console.error(`  Already on the registry: ${published.join(", ")}`);
    }
    console.error(`  Fix the cause and re-run \`pnpm release ${version}\`; it resumes from here.`);
    process.exit(1);
  }
  verifyRegistryContents(name, candidate.files);
  published.push(name);
  console.log(`  ✓ ${name}@${version}`);
}

// Record the release only after every registry upload is confirmed so tags cannot imply partial publication.

step("Recording the release");

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
originalManifests.clear();
if (!existingTag) run("git", ["tag", "-a", tag, releaseCommit, "-m", `Dougong ${version}`]);
const tagObject = existingTag ?? capture("git", ["rev-parse", tagRef]);
if (
  capture("git", ["cat-file", "-t", tagObject]) !== "tag" ||
  capture("git", ["rev-parse", `${tagObject}^{commit}`]) !== releaseCommit
)
  fail(`tag ${tag} does not record the verified release; refusing to push`);
// Pin both sides: a plain fast-forward push can recreate a branch somebody just deleted.
run("git", [
  "push",
  "--atomic",
  "--no-follow-tags",
  `--force-with-lease=${mainRef}:${remoteMain}`,
  `--force-with-lease=${tagRef}:${remoteTag.split("\t")[0]}`,
  "origin",
  `${releaseCommit}:${mainRef}`,
  `${tagObject}:${tagRef}`,
]);

console.log(`\n[32m✓ Dougong ${version} released[0m`);
for (const { name } of PACKAGES)
  console.log(`    https://www.npmjs.com/package/${name}/v/${version}`);
console.log();
