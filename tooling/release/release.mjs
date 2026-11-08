#!/usr/bin/env node

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { candidateOutput } from "../consumer/package-candidates.mjs";
import { ReleaseRequest } from "./release-request.mjs";
import { inspectReleaseRepository } from "./release-repository.mjs";
import { captureReleaseRegistry, registryVisibilityTimeoutMinutes } from "./release-registry.mjs";
import { ReleaseSession } from "./release-session.mjs";

function step(message) {
  console.log(`\n\u001b[1m▸ ${message}\u001b[0m`);
}

function showCandidates(candidates, version) {
  const packageNameColumnWidth = 22;
  const packageSizeColumnWidth = 7;
  const bytesPerKibibyte = 1024;
  for (const {
    entry: { name, distributionTag },
    candidate,
    canSkipUpload,
  } of candidates) {
    if (canSkipUpload) {
      console.log(
        `  ${name.padEnd(packageNameColumnWidth)} ${"skip".padStart(packageSizeColumnWidth)}     already published, contents match`,
      );
      continue;
    }
    const size = (candidate.bytes.byteLength / bytesPerKibibyte).toFixed(1);
    console.log(
      `  ${name.padEnd(packageNameColumnWidth)} ${size.padStart(packageSizeColumnWidth)} KB  ${version} (--tag=${distributionTag})`,
    );
  }
}

async function confirmPublication(session, request) {
  if (request.assumeYes) return;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = await prompt.question(
      `\nPublish ${request.packages.length} packages at ${request.version}? [y/N] `,
      { signal: session.signal },
    );
  } finally {
    prompt.close();
  }
  if (answer.trim().toLowerCase() === "y") return;
  if (!(await session.restoreManifests()))
    throw new Error("aborted; checkout moved, inspect manifests before resuming");
  throw new Error("aborted; package.json versions restored");
}

async function publishCandidates(session, request, repository, registry, candidates, stage) {
  const published = [];
  const { version, resumeCommand } = request;
  for (const { entry, candidate, canSkipUpload } of candidates) {
    const { name } = entry;
    if (canSkipUpload) {
      console.log(`  · ${name}@${version} already published, skipped`);
      continue;
    }
    await repository.assertPublicationInputs("publish " + name);
    // The receipt binds captured bytes; copying them avoids rereading a mutable candidate archive.
    const upload = join(mkdtempSync(join(stage, "upload-")), candidate.filename);
    writeFileSync(upload, candidate.bytes, { flag: "wx" });
    await repository.assertRemoteReferences();
    try {
      await registry.publish(entry, upload);
    } catch (cause) {
      if (session.signal.aborted) throw cause;
      if (published.length) console.error(`  Already on the registry: ${published.join(", ")}`);
      console.error(`  Fix the cause and re-run \`${resumeCommand}\`; it resumes from here.`);
      throw new Error(`${name} failed to publish.`, { cause });
    }
    // A successful upload can remain unreadable; dependents require a confirmed provider first.
    if (!(await registry.waitForVisibility(name))) {
      if (published.length) console.error(`  Already published: ${published.join(", ")}`);
      console.error(`  Re-running \`${resumeCommand}\` resumes from here.`);
      throw new Error(
        `${name}: npm accepted ${version}, but it was not readable within ${registryVisibilityTimeoutMinutes} minutes; processing may still be pending.`,
      );
    }
    await registry.verifyPublishedPackage(entry, candidate, stage);
    published.push(name);
    console.log(`  ✓ ${name}@${version}`);
  }
}

async function release(session) {
  const request = new ReleaseRequest();
  const { version, packages, dryRun } = request;
  console.log(
    `\nDougong release: ${packages[0].currentVersion} → ${version}${dryRun ? "  (dry run)" : ""}`,
  );

  step("Verifying repository state");
  const repository = await inspectReleaseRepository(session, request);
  step("Verifying registry state");
  request.assertOriginalManifests();
  const registry = await captureReleaseRegistry(session, request, repository.isRecordedRemotely);
  if (!dryRun) await registry.authenticate();
  const publishedNames = await registry.publishedNames();
  if (repository.hasReleaseRecord && publishedNames.length !== packages.length) {
    throw new Error(
      "Git records this release but not every package is published; refusing to advance it",
    );
  }
  if (publishedNames.length) {
    console.log(`  resuming: ${publishedNames.join(", ")} already at ${version}`);
  } else {
    console.log(`  ${version} is unused on the registry`);
  }
  await repository.assertReadyToBump();

  step("Bumping versions");
  session.replaceManifests(packages, repository.source);
  step("Running the full gate (pnpm check) on the release versions");
  const stage = session.createStage();
  await session.run("pnpm", ["check"], { env: { ...process.env, [candidateOutput]: stage } });
  await repository.assertBuildSource();
  const candidates = await registry.verifyCandidates(
    request.readCandidates(stage),
    publishedNames,
    stage,
  );
  showCandidates(candidates, version);

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
  await confirmPublication(session, request);
  step("Publishing");
  console.log(
    "  If two-factor authentication is enabled, npm prints a URL and waits for\n" +
      "  browser approval. Nothing is published until you complete it.\n" +
      "  Pass --otp=<code> instead to authorize from the terminal.\n",
  );
  await publishCandidates(session, request, repository, registry, candidates, stage);

  step("Recording the release");
  // Waiting for uploads or approval can outlive an earlier channel observation.
  for (const entry of packages) await registry.assertDistributionTag(entry);
  await repository.record();
  console.log(`\n\u001b[32m✓ Dougong ${version} released\u001b[0m`);
  for (const { name } of packages)
    console.log(`    ${name}@${version} (${registry.destinationFor(name)})`);
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
