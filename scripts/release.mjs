#!/usr/bin/env node
// One-command release for the four published packages.
//
//   node scripts/release.mjs <version> [--dry-run] [--yes] [--otp=<code>]
//
// The order below is not arbitrary. Version 0.0.1 of this project shipped
// broken because `dist/` still held the previous scope: the gate had been read
// from the wrong exit code and nobody looked inside the tarball. So this script
// refuses to trust anything it has not verified itself:
//
//   * a clean tree that matches origin, so the published commit is the pushed one
//   * the full `pnpm check`, whose exit code is read directly, never through a pipe
//   * `npm pack` tarballs extracted and inspected, because listing a tarball with
//     glob flags is not portable and silently reported "clean" once before
//   * publish in dependency order, and poll the registry after each upload,
//     because an exit code is not proof: npm's browser two-factor wait can be
//     interrupted, and a release that uploaded nothing once looked finished
//
// npm versions are immutable, so a run that stops midway is resumable rather
// than requiring a version bump. Re-running the same version skips packages
// already on the registry, but only after comparing their published contents
// with what this run would upload.
//
// `--dry-run` performs every check and every packaging step, and stops before
// the first irreversible action (publish, tag, push).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Dependency order: a package is published only after everything it depends on.
const PACKAGES = [
  { dir: "packages/reactive", name: "@dougongjs/reactive" },
  { dir: "packages/core", name: "@dougongjs/core" },
  { dir: "packages/platform", name: "@dougongjs/platform" },
  { dir: "packages/dougong", name: "dougong" },
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const assumeYes = args.includes("--yes");
const version = args.find((argument) => !argument.startsWith("--"));

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function step(message) {
  console.log(`\n[1m▸ ${message}[0m`);
}

/** Runs a command, streaming output, and fails on a non-zero exit code. */
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

// 1 · Inputs

if (!version) {
  fail("usage: node scripts/release.mjs <version> [--dry-run] [--yes]");
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`'${version}' is not a semantic version`);
}

const current = readManifest(PACKAGES[0].dir).version;
console.log(`\nDougong release: ${current} → ${version}${dryRun ? "  (dry run)" : ""}`);

// 2 · Repository state
//
// Publishing from a tree that differs from origin produces an artifact whose
// source nobody can check out later.

step("Verifying repository state");

const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") fail(`on branch '${branch}'; releases are cut from main`);

if (capture("git", ["status", "--porcelain"])) {
  fail("working tree is not clean; commit or stash first");
}

run("git", ["fetch", "--quiet", "origin", "main"]);
const ahead = capture("git", ["rev-list", "--count", "origin/main..HEAD"]);
const behind = capture("git", ["rev-list", "--count", "HEAD..origin/main"]);
if (behind !== "0") fail(`local main is ${behind} commit(s) behind origin/main`);
if (ahead !== "0") fail(`local main is ${ahead} commit(s) ahead of origin/main; push first`);

const tag = `v${version}`;
if (capture("git", ["tag", "--list", tag])) fail(`tag ${tag} already exists`);
console.log(
  `  main is clean and equals origin/main at ${capture("git", ["rev-parse", "--short", "HEAD"])}`,
);

// 3 · Registry state
//
// Checked before the gate so a duplicate version fails in seconds, not minutes.

step("Verifying registry state");

if (!dryRun) {
  const whoami = spawnSync("npm", ["whoami"], { encoding: "utf8" });
  if (whoami.status !== 0) fail("not logged in to npm; run `npm login` first");
  console.log(`  publishing as ${whoami.stdout.trim()}`);
}

/** Reads a published field, always from the network. A cached miss once aborted a good release. */
function registryField(name, field) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, field, "--prefer-online"], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

// A release can stop midway — npm's two-factor wait is interruptible and
// versions are immutable. Rather than force a version bump, packages already
// at this version are skipped, but only after their published contents are
// compared with what this run would upload.
const alreadyPublished = new Set();
for (const { name } of PACKAGES) {
  if (registryField(name, "version") === version) alreadyPublished.add(name);
}
if (alreadyPublished.size === PACKAGES.length) {
  fail(`${version} is already published for every package`);
}
if (alreadyPublished.size) {
  console.log(`  resuming: ${[...alreadyPublished].join(", ")} already at ${version}`);
} else {
  console.log(`  ${version} is unused on the registry`);
}

// 4 · The gate
//
// `pnpm check` ends with build, so dist/ is regenerated from this exact commit.
// Its status is read directly rather than through a pipeline, because reading
// `$?` after a pipe reports the last command in the pipe and hid a real failure
// here once.

step("Running the full gate (pnpm check)");
run("pnpm", ["check"]);

// 5 · Version bump
//
// All four move together. `workspace:*` is rewritten by pnpm at pack time, so
// the dependency versions follow automatically once the manifests agree.

step("Bumping versions");

const originalManifests = new Map();
for (const { dir, name } of PACKAGES) {
  const manifest = readManifest(dir);
  originalManifests.set(dir, JSON.stringify(manifest, null, 2) + "\n");
  manifest.version = version;
  writeManifest(dir, manifest);
  console.log(`  ${name} → ${version}`);
}

function restoreManifests() {
  for (const [dir, contents] of originalManifests) writeFileSync(manifestPath(dir), contents);
}

process.on("exit", (code) => {
  if (code !== 0 && originalManifests.size) restoreManifests();
});

// A signal terminates the process without emitting `exit`, so the handler above
// never runs. Interrupting at the confirmation prompt, or during npm's browser
// two-factor wait, once left all four manifests bumped in a clean checkout.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (originalManifests.size) {
      restoreManifests();
      console.error("\n  interrupted — package.json versions restored");
    }
    process.exit(130);
  });
}

// 6 · Pack and inspect
//
// The tarball is the artifact consumers receive. Everything before this point
// describes intent; this is the only step that reads what actually ships.

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

  const extracted = join(stage, name.replace("/", "__"));
  execFileSync("mkdir", ["-p", extracted]);
  // Extract rather than list: `tar --wildcards` is not portable, and a listing
  // filter that silently matched nothing once reported a broken tarball as clean.
  execFileSync("tar", ["-xzf", tarball, "-C", extracted]);
  const root = join(extracted, "package");

  const packedManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (packedManifest.version !== version) {
    fail(`${name}: tarball declares version ${packedManifest.version}`);
  }
  for (const [dependency, range] of Object.entries(packedManifest.dependencies ?? {})) {
    if (range.startsWith("workspace:")) {
      fail(`${name}: tarball still depends on ${dependency}@${range}`);
    }
    if (dependency.startsWith("@dougongjs/") || dependency === "dougong") {
      if (!range.includes(version)) {
        fail(`${name}: tarball pins ${dependency}@${range}, expected ${version}`);
      }
    }
  }
  for (const required of ["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE"]) {
    if (!existsSync(join(root, required))) fail(`${name}: tarball is missing ${required}`);
  }

  // Nothing in a shipped bundle may reference a workspace path or a retired scope.
  const bundle = readFileSync(join(root, "dist/index.js"), "utf8");
  const declaration = readFileSync(join(root, "dist/index.d.ts"), "utf8");
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

  // A package already at this version is only safe to skip if what is on the
  // registry matches what this run would upload. Contents are compared rather
  // than tarball bytes, because archive metadata is not reproducible.
  if (alreadyPublished.has(name)) {
    const downloaded = join(stage, `published__${name.replace("/", "__")}`);
    execFileSync("mkdir", ["-p", downloaded]);
    execFileSync("npm", ["pack", `${name}@${version}`, "--pack-destination", downloaded], {
      stdio: "ignore",
    });
    const [archive] = globSync(join(downloaded, "*.tgz"));
    if (!archive) fail(`${name}: cannot download the published ${version} to compare`);
    execFileSync("tar", ["-xzf", archive, "-C", downloaded]);
    const publishedRoot = join(downloaded, "package");
    for (const file of ["dist/index.js", "dist/index.d.ts", "package.json"]) {
      if (
        readFileSync(join(publishedRoot, file), "utf8") !== readFileSync(join(root, file), "utf8")
      )
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

// 7 · Confirm

if (dryRun) {
  step("Dry run complete");
  console.log("  every check passed; no package was published, tagged or pushed");
  console.log(`  tarballs kept at ${stage}`);
  restoreManifests();
  originalManifests.clear();
  console.log("  package.json versions restored\n");
  process.exit(0);
}

if (!assumeYes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nPublish ${PACKAGES.length} packages at ${version}? [y/N] `);
  rl.close();
  if (answer.trim().toLowerCase() !== "y") {
    restoreManifests();
    originalManifests.clear();
    fail("aborted; package.json versions restored");
  }
}

// 8 · Publish
//
// In dependency order, from the inspected tarball rather than from the working
// directory, so what was verified is exactly what is uploaded.
//
// Each upload is then confirmed against the registry. An exit code alone is not
// evidence: npm's browser two-factor flow polls for an authorization that may
// never arrive, and an interrupted release once looked like a finished one.

step("Publishing");

console.log(
  "  If two-factor authentication is enabled, npm prints a URL and waits for\n" +
    "  browser approval. Nothing is published until you complete it.\n" +
    "  Pass --otp=<code> instead to authorize from the terminal.\n",
);

/**
 * Confirms the upload is resolvable before a dependent package is published.
 *
 * The registry is read-your-writes only eventually, so a single immediate read
 * can miss a version that did land — which once aborted a healthy release right
 * after its first successful upload. Poll instead of asking once.
 */
function awaitRegistry(name) {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (registryField(name, "version") === version) return true;
    execFileSync("sleep", ["2"]);
  }
  return false;
}

const otp = args.find((argument) => argument.startsWith("--otp="));
const published = [];
for (const { name } of PACKAGES) {
  if (alreadyPublished.has(name)) {
    console.log(`  · ${name}@${version} already published, skipped`);
    continue;
  }
  const publishArgs = ["publish", tarballs.get(name), "--access", "public"];
  if (otp) publishArgs.push(otp);
  const result = spawnSync("npm", publishArgs, { stdio: "inherit" });
  if (result.status === 0 && !awaitRegistry(name)) {
    console.error(
      `\n✗ ${name}: npm reported success but ${version} never appeared on the registry.`,
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

// 9 · Record
//
// The commit and tag land only after every package is on the registry, so a tag
// never points at a release that does not exist.

step("Recording the release");

originalManifests.clear();
run("git", ["add", ...PACKAGES.map(({ dir }) => manifestPath(dir))]);
run("git", ["commit", "--no-verify", "-m", `chore: release ${version}`]);
run("git", ["tag", "-a", tag, "-m", `Dougong ${version}`]);
run("git", ["push", "origin", "main", "--follow-tags"]);

rmSync(stage, { recursive: true, force: true });

console.log(`\n[32m✓ Dougong ${version} released[0m`);
for (const { name } of PACKAGES)
  console.log(`    https://www.npmjs.com/package/${name}/v/${version}`);
console.log();
