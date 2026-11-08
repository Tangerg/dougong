import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { valid, validRange } from "semver";
import { readVerifiedCandidates, verifyManifest } from "../consumer/package-candidates.mjs";
import { packageName, publishedDirectories } from "../packages.mjs";
import { manifestPath } from "./release-session.mjs";

export function versionedManifest(contents, version) {
  const manifest = JSON.parse(contents);
  manifest.version = version;
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

function capturePackage(directory, version, requestedTag) {
  const original = readFileSync(manifestPath(directory));
  const manifest = JSON.parse(original);
  const name = packageName(manifest.name);
  const distributionTag = requestedTag === undefined ? manifest.publishConfig?.tag : requestedTag;
  if (distributionTag === undefined)
    throw new Error(`${name}: a release needs --tag=<dist-tag> or publishConfig.tag`);
  if (
    typeof distributionTag !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(distributionTag) ||
    validRange(distributionTag) !== null
  )
    throw new Error(`${name}: invalid npm dist-tag; use a channel name such as next or beta`);
  return Object.freeze({
    directory,
    name,
    distributionTag,
    publishConfig: manifest.publishConfig,
    currentVersion: manifest.version,
    original,
    versioned: versionedManifest(original, version),
  });
}

export class ReleaseRequest {
  constructor() {
    if (process.platform !== "linux" && process.platform !== "darwin") {
      throw new Error("Releases require Linux or macOS with git, npm and pnpm executables on PATH");
    }
    const { values, positionals, tokens } = parseArgs({
      options: {
        "dry-run": { type: "boolean" },
        yes: { type: "boolean" },
        otp: { type: "string" },
        tag: { type: "string" },
      },
      allowPositionals: true,
      tokens: true,
    });
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
    if (values.otp !== undefined && !values.otp.trim())
      throw new Error("--otp must be a non-empty code");
    const packages = publishedDirectories.map((directory) =>
      capturePackage(directory, version, values.tag),
    );
    if (new Set(packages.map(({ name }) => name)).size !== packages.length)
      throw new Error("Release package names must be unique");

    this.version = version;
    this.dryRun = values["dry-run"] === true;
    this.assumeYes = values.yes === true;
    this.oneTimePassword = values.otp;
    this.packages = Object.freeze(packages);
    this.manifestFiles = Object.freeze(packages.map(({ directory }) => manifestPath(directory)));
    this.resumeCommand = `pnpm release ${version}${values.tag === undefined ? "" : ` --tag=${values.tag}`}`;
    Object.freeze(this);
  }

  assertOriginalManifests() {
    for (const { directory, original } of this.packages) {
      if (!readFileSync(manifestPath(directory)).equals(original))
        throw new Error(`${directory}/package.json changed since release input capture`);
    }
  }

  assertVersionedManifests(action) {
    for (const { directory, versioned } of this.packages) {
      if (!readFileSync(manifestPath(directory)).equals(versioned)) {
        throw new Error(`${directory}/package.json changed during release; refusing to ${action}`);
      }
    }
  }

  readCandidates(stage) {
    const candidates = readVerifiedCandidates(stage);
    const versions = new Map(this.packages.map(({ name }) => [name, this.version]));
    return Object.freeze(
      this.packages.map((entry) => {
        const candidate = candidates.get(entry.directory);
        verifyManifest(
          JSON.parse(entry.versioned),
          JSON.parse(candidate.files.get("package.json")),
          versions,
        );
        return Object.freeze({ entry, candidate });
      }),
    );
  }
}
