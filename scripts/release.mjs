#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { valid } from "semver";
import { readPackageFiles } from "./release-archive.mjs";

const PACKAGE_DIRECTORIES = [
  "packages/reactive",
  "packages/core",
  "packages/platform",
  "packages/dougong",
];

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
  return resolve(dir, "package.json");
}

function readManifest(dir) {
  return JSON.parse(readFileSync(manifestPath(dir), "utf8"));
}

function writeManifest(dir, manifest) {
  writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`);
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
  fail("usage: node scripts/release.mjs <version> [--dry-run] [--yes] [--otp=<code>]");
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

const PACKAGES = PACKAGE_DIRECTORIES.map((dir) => {
  const { name } = readManifest(dir);
  if (typeof name !== "string" || !name || name !== name.trim()) {
    fail(`${dir}/package.json must declare a non-empty trimmed package name`);
  }
  return { dir, name };
});
const packageNames = new Set(PACKAGES.map(({ name }) => name));
if (packageNames.size !== PACKAGES.length) fail("Release package names must be unique");
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
const ahead = capture("git", ["rev-list", "--count", "origin/main..HEAD"]);
const behind = capture("git", ["rev-list", "--count", "HEAD..origin/main"]);
if (behind !== "0") fail(`local main is ${behind} commit(s) behind origin/main`);

// Git owns the release record; a separate recovery marker could disagree with the actual commit.
function isPendingReleaseCommit() {
  if (ahead !== "1") return false;
  if (capture("git", ["show", "-s", "--format=%B", "HEAD"]) !== `chore: release ${version}`) {
    return false;
  }
  const parents = capture("git", ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ");
  if (parents.length !== 2 || parents[1] !== capture("git", ["rev-parse", "origin/main"])) {
    return false;
  }
  const changed = capture("git", ["diff", "--name-only", "origin/main", "HEAD"]).split("\n");
  if (changed.some((file) => !PACKAGES.some(({ dir }) => file === `${dir}/package.json`))) {
    return false;
  }
  return PACKAGES.every(({ dir }) => {
    const previous = JSON.parse(capture("git", ["show", `origin/main:${dir}/package.json`]));
    previous.version = version;
    return readFileSync(manifestPath(dir), "utf8") === `${JSON.stringify(previous, null, 2)}\n`;
  });
}

const pendingReleaseCommit = isPendingReleaseCommit();
if (ahead !== "0" && !pendingReleaseCommit) {
  fail(`local main is ${ahead} commit(s) ahead of origin/main; push first`);
}

const tag = `v${version}`;
const head = capture("git", ["rev-parse", "HEAD"]);
const hasTag = Boolean(capture("git", ["tag", "--list", tag]));
if (
  hasTag &&
  (!PACKAGES.every(({ dir }) => readManifest(dir).version === version) ||
    capture("git", ["cat-file", "-t", `refs/tags/${tag}`]) !== "tag" ||
    capture("git", ["rev-parse", `refs/tags/${tag}^{commit}`]) !== head)
) {
  fail(`tag ${tag} already exists but does not record this release`);
}
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
if ((pendingReleaseCommit || hasTag) && alreadyPublished.size !== PACKAGES.length) {
  fail("Git records this release but not every package is published; refusing to advance it");
}
if (alreadyPublished.size) {
  console.log(`  resuming: ${[...alreadyPublished].join(", ")} already at ${version}`);
} else {
  console.log(`  ${version} is unused on the registry`);
}

step("Running the full gate (pnpm check)");
run("pnpm", ["check"]);

step("Bumping versions");

// Capture all originals before writing so a partial write can restore every manifest.
const originalManifests = new Map(
  PACKAGES.map(({ dir }) => [dir, readFileSync(manifestPath(dir))]),
);
let recordingIndex = false;

function restoreManifests() {
  if (recordingIndex) {
    // A failed process can still commit; rollback must follow the Git fact rather than its exit code.
    if (capture("git", ["rev-parse", "HEAD"]) !== head) {
      originalManifests.clear();
      return false;
    }
  }
  const originals = [...originalManifests];
  originalManifests.clear();
  const errors = [];
  for (const [dir, contents] of originals) {
    try {
      writeFileSync(manifestPath(dir), contents);
    } catch (cause) {
      errors.push(new Error(`Could not restore ${dir}/package.json`, { cause }));
    }
  }
  if (recordingIndex) {
    try {
      capture("git", ["restore", "--staged", "--", ...manifestFiles]);
    } catch (cause) {
      errors.push(new Error("Could not restore the staged release manifests", { cause }));
    }
  }
  if (errors.length) throw new AggregateError(errors, "Release manifest restoration failed");
  return true;
}

process.on("exit", (code) => {
  if (code !== 0 && originalManifests.size) {
    try {
      restoreManifests();
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
            : `\n  interrupted — release commit preserved; re-run pnpm release ${version}`,
        );
      } catch (error) {
        console.error(error);
      }
    }
    process.exit(130);
  });
}

for (const { dir, name } of PACKAGES) {
  const manifest = JSON.parse(originalManifests.get(dir).toString("utf8"));
  manifest.version = version;
  writeManifest(dir, manifest);
  console.log(`  ${name} → ${version}`);
}

step("Packing and inspecting tarballs");

const stage = mkdtempSync(join(tmpdir(), "dougong-release-"));
const tarballs = new Map();

for (const { dir, name } of PACKAGES) {
  const packed = capture("pnpm", ["pack", "--pack-destination", stage], { cwd: resolve(dir) })
    .split("\n")
    .at(-1);
  const tarball = resolve(packed.startsWith("/") ? packed : join(stage, packed));
  if (!existsSync(tarball)) fail(`${name}: pnpm pack did not produce ${tarball}`);
  tarballs.set(name, tarball);

  const candidateFiles = readPackageFiles(tarball);
  for (const required of [
    "package.json",
    "dist/index.js",
    "dist/index.d.ts",
    "README.md",
    "LICENSE",
  ]) {
    if (!candidateFiles.has(required)) fail(`${name}: tarball is missing ${required}`);
  }

  const packedManifest = JSON.parse(candidateFiles.get("package.json"));
  if (packedManifest.name !== name) {
    fail(`${name}: tarball declares name ${packedManifest.name}`);
  }
  if (packedManifest.version !== version) {
    fail(`${name}: tarball declares version ${packedManifest.version}`);
  }
  const declaredDependencies = JSON.parse(originalManifests.get(dir)).dependencies ?? {};
  const expectedDependencies = new Map(
    Object.entries(declaredDependencies).map(([dependency, range]) => [
      dependency,
      packageNames.has(dependency) ? version : range,
    ]),
  );
  const packedDependencies = packedManifest.dependencies ?? {};
  for (const dependency of new Set([
    ...expectedDependencies.keys(),
    ...Object.keys(packedDependencies),
  ])) {
    const range = packedDependencies[dependency];
    const expected = expectedDependencies.get(dependency);
    if (typeof range === "string" && range.startsWith("workspace:")) {
      fail(`${name}: tarball still depends on ${dependency}@${range}`);
    }
    if (range !== expected) {
      fail(
        `${name}: tarball declares ${dependency}@${range ?? "(missing)"}, expected ${expected ?? "(absent)"}`,
      );
    }
  }
  const bundle = candidateFiles.get("dist/index.js").toString("utf8");
  const declaration = candidateFiles.get("dist/index.d.ts").toString("utf8");
  for (const [label, contents] of [
    ["dist/index.js", bundle],
    ["dist/index.d.ts", declaration],
  ]) {
    for (const forbidden of ["@dougong/", "/Users/", "workspace:", "src/index.ts"]) {
      if (contents.includes(forbidden)) {
        fail(`${name}: ${label} contains '${forbidden}'`);
      }
    }
  }

  // Compare existing registry bytes because immutable versions cannot accept a different artifact on resume.
  if (alreadyPublished.has(name)) {
    const downloaded = join(stage, `published__${basename(dir)}`);
    mkdirSync(downloaded, { recursive: true });
    execFileSync("npm", ["pack", `${name}@${version}`, "--pack-destination", downloaded], {
      stdio: "ignore",
    });
    const [archive] = globSync(join(downloaded, "*.tgz"));
    if (!archive) fail(`${name}: cannot download the published ${version} to compare`);
    const publishedFiles = readPackageFiles(archive);
    for (const file of new Set([...publishedFiles.keys(), ...candidateFiles.keys()])) {
      const publishedContents = publishedFiles.get(file);
      const candidateContents = candidateFiles.get(file);
      if (!publishedContents || !candidateContents || !publishedContents.equals(candidateContents))
        fail(
          `${name}@${version} is published but its ${file} differs from this build; ` +
            `release a new version instead of resuming`,
        );
    }
    console.log(`  ${name.padEnd(22)} ${"skip".padStart(7)}     already published, contents match`);
    continue;
  }

  const size = (readFileSync(tarball).byteLength / 1024).toFixed(1);
  console.log(`  ${name.padEnd(22)} ${size.padStart(7)} KB  ${packedManifest.version}`);
}

if (dryRun) {
  restoreManifests();
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
    restoreManifests();
    fail("aborted; package.json versions restored");
  }
}

// Publish inspected tarballs so verified bytes are the uploaded bytes; confirm registry presence before recording success.

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

const published = [];
for (const { name } of PACKAGES) {
  if (alreadyPublished.has(name)) {
    console.log(`  · ${name}@${version} already published, skipped`);
    continue;
  }
  const publishArgs = ["publish", tarballs.get(name), "--access", "public"];
  if (otp !== undefined) publishArgs.push(`--otp=${otp}`);
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
  published.push(name);
  console.log(`  ✓ ${name}@${version}`);
}

// Record the release only after every registry upload is confirmed so tags cannot imply partial publication.

step("Recording the release");

recordingIndex = true;
run("git", ["add", ...manifestFiles]);
const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { stdio: "inherit" });
if (staged.error) fail(`Cannot inspect staged release manifests: ${staged.error.message}`);
if (staged.status === 1) run("git", ["commit", "-m", `chore: release ${version}`]);
else if (staged.status !== 0) fail(`Cannot inspect staged release manifests (${staged.status})`);
originalManifests.clear();
if (!hasTag) run("git", ["tag", "-a", tag, "-m", `Dougong ${version}`]);
run("git", ["push", "--atomic", "--no-follow-tags", "origin", "main", `refs/tags/${tag}`]);

rmSync(stage, { recursive: true, force: true });

console.log(`\n[32m✓ Dougong ${version} released[0m`);
for (const { name } of PACKAGES)
  console.log(`    https://www.npmjs.com/package/${name}/v/${version}`);
console.log();
