import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { packageEntrypoints, packageName, publishedDirectories } from "../packages.mjs";
import { packageArchiveIn, readPackageFiles } from "../package-archive.mjs";

export const candidateOutput = "DOUGONG_VERIFIED_CANDIDATES";
const producerHooks = new Set([
  "prepublishOnly",
  "prepack",
  "prepare",
  "postpack",
  "publish",
  "postpublish",
]);
const dependencyFields = new Set([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
]);

export function differingFile(expected, actual) {
  for (const name of new Set([...expected.keys(), ...actual.keys()])) {
    const bytes = actual.get(name);
    if (!bytes || !expected.get(name)?.equals(bytes)) return name;
  }
}

// Capture before the first pack hook runs: even a later package's ignored dist may be rewritten.
function declaredFiles(source, manifest) {
  const files = new Map();
  function visit(path) {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry)
      throw new Error(`${manifest.name}: missing ${relative(source, path)} in the package source`);
    if (entry.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (entry.isFile()) {
      files.set(relative(source, path).split(/[/\\]/).join("/"), readFileSync(path));
    } else {
      throw new Error(`Package entry '${relative(source, path)}' must be a regular file`);
    }
  }
  if (!Array.isArray(manifest.files))
    throw new Error(`${manifest.name}: declare the files to publish`);
  for (const name of new Set([...manifest.files, "README.md", "LICENSE"])) {
    if (
      typeof name !== "string" ||
      /[\\:*?![\]{}]/.test(name) ||
      name
        .split("/")
        .some(
          (part) =>
            !part || part === "." || part === ".." || part === "node_modules" || part === ".git",
        )
    )
      throw new Error(`${manifest.name}: use literal package files or directories: ${name}`);
    const path = join(source, name);
    // Reject traversal through a symlinked ancestor without opening it.
    for (let parent = dirname(path); parent !== source; parent = dirname(parent)) {
      if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink())
        throw new Error(`Package entry '${name}' must be a regular file`);
    }
    visit(path);
  }
  files.delete("package.json");
  return files;
}

export function verifyManifest(declared, packed, versions) {
  const { name } = declared;
  for (const key of ["name", "type", "version"]) {
    if (packed[key] !== declared[key])
      throw new Error(`${name}: tarball declares ${key} ${packed[key]}, expected ${declared[key]}`);
  }
  // Only pack-time authoring fields may disappear. Unknown metadata travels unchanged, including publishConfig.
  for (const field of new Set([...Object.keys(declared), ...Object.keys(packed)])) {
    const expected = Object.hasOwn(declared, field) ? declared[field] : undefined;
    const actual = Object.hasOwn(packed, field) ? packed[field] : undefined;
    if ((field === "pnpm" || field === "packageManager") && actual === undefined) continue;
    if (field === "scripts" || dependencyFields.has(field)) {
      if (actual !== undefined && (!actual || typeof actual !== "object" || Array.isArray(actual)))
        throw new Error(`${name}: invalid packed ${field}`);
      for (const key of new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})])) {
        const value = Object.hasOwn(actual ?? {}, key) ? actual[key] : undefined;
        let wanted = Object.hasOwn(expected ?? {}, key) ? expected[key] : undefined;
        if (field === "scripts" && producerHooks.has(key) && value === undefined) continue;
        if (
          dependencyFields.has(field) &&
          typeof wanted === "string" &&
          wanted.startsWith("workspace:")
        ) {
          const operator = wanted.slice("workspace:".length);
          if (!versions.has(key) || !["*", "^", "~"].includes(operator))
            throw new Error(`${name}: unsupported workspace dependency ${key}@${wanted}`);
          wanted = (operator === "*" ? "" : operator) + versions.get(key);
        }
        if (value !== wanted)
          throw new Error(
            `${name}: tarball declares ${field}.${key} = ${value ?? "(missing)"}, expected ${wanted ?? "(absent)"}`,
          );
      }
    } else {
      const ordered = ["exports", "imports", "typesVersions"].includes(field);
      if (
        ordered
          ? JSON.stringify(actual) !== JSON.stringify(expected)
          : !isDeepStrictEqual(actual, expected)
      )
        throw new Error(`${name}: tarball ${field} differs from its declaration`);
    }
  }
}

export function packCandidates(root) {
  const sources = publishedDirectories.map((packageDirectory) => {
    const source = resolve(root, packageDirectory);
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    packageName(manifest.name);
    return { packageDirectory, source, manifest, expected: declaredFiles(source, manifest) };
  });
  const versions = new Map(sources.map(({ manifest }) => [manifest.name, manifest.version]));
  if (versions.size !== sources.length) throw new Error("Workspace package names must be unique");
  const candidates = new Map();
  for (const { packageDirectory, source, manifest, expected } of sources) {
    const packed = mkdtempSync(join(tmpdir(), "dougong-pack-"));
    try {
      execFileSync("pnpm", ["pack", "--pack-destination", packed], { cwd: source, stdio: "pipe" });
      const archive = packageArchiveIn(packed);
      const bytes = readFileSync(archive);
      const files = readPackageFiles(archive, bytes);
      for (const required of [
        "package.json",
        "README.md",
        "LICENSE",
        ...packageEntrypoints(manifest).flatMap(({ types, module }) => [module, types]),
      ]) {
        if (!files.has(required))
          throw new Error(`${manifest.name}: tarball is missing ${required}`);
      }
      verifyManifest(manifest, JSON.parse(files.get("package.json")), versions);
      const content = new Map(files);
      content.delete("package.json");
      const changed = differingFile(expected, content);
      if (changed !== undefined)
        throw new Error(
          `${manifest.name}: ${changed} differs from the verified build before packing`,
        );
      for (const [file, data] of content) {
        if (!file.startsWith("dist/") || !/\.(?:js|d\.ts)$/.test(file)) continue;
        const contents = data.toString("utf8");
        for (const forbidden of ["@dougong/", "/Users/", "workspace:", "src/index.ts"])
          if (contents.includes(forbidden))
            throw new Error(`${manifest.name}: ${file} contains '${forbidden}'`);
      }
      candidates.set(packageDirectory, {
        name: manifest.name,
        source,
        files,
        filename: basename(archive),
        bytes,
      });
    } finally {
      rmSync(packed, { recursive: true, force: true });
    }
  }
  return candidates;
}

const digest = (bytes) => createHash("sha512").update(bytes).digest("hex");

export function writeVerifiedCandidates(output, candidates) {
  const receipts = {};
  for (const [packageDirectory, { filename, bytes }] of candidates) {
    const directory = join(output, basename(packageDirectory));
    mkdirSync(directory);
    writeFileSync(join(directory, filename), bytes, { flag: "wx" });
    receipts[packageDirectory] = digest(bytes);
  }
  // A completed receipt means every candidate passed as a set, even when the gate runs in another process.
  writeFileSync(join(output, "verified.json"), JSON.stringify(receipts), { flag: "wx" });
}

export function readVerifiedCandidates(output) {
  const receipts = JSON.parse(readFileSync(join(output, "verified.json"), "utf8"));
  return new Map(
    publishedDirectories.map((packageDirectory) => {
      const archive = packageArchiveIn(join(output, basename(packageDirectory)));
      const bytes = readFileSync(archive);
      if (digest(bytes) !== receipts[packageDirectory])
        throw new Error(`${packageDirectory}: archive changed after consumer verification`);
      return [
        packageDirectory,
        { filename: basename(archive), bytes, files: readPackageFiles(archive, bytes) },
      ];
    }),
  );
}
