import { readFileSync } from "node:fs";
import { Parser } from "tar";

export function readPackageFiles(archive) {
  // Extraction loses link types, duplicate members and case-sensitive paths.
  const entries = new Map();
  const parser = new Parser({ strict: true, file: archive });
  let archiveEnded = false;
  parser.once("eof", () => {
    archiveEnded = true;
  });
  const readEntry = (entry) => {
    const directory = entry.type === "Directory";
    const path = directory ? entry.path.replace(/\/$/, "") : entry.path;
    const [root, ...parts] = path.split("/");
    if (root !== "package") {
      throw new Error(`Package archive must contain only the package directory: ${archive}`);
    }
    const file = parts.join("/");
    if (!file && !directory) throw new Error("Package root must be a directory");
    if (
      entry.header.path.includes("\\") ||
      parts.some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Package entry '${path}' must have a canonical path`);
    }
    if (!directory && entry.type !== "File" && entry.type !== "OldFile") {
      throw new Error(`Package entry '${file}' must be a regular file`);
    }
    if (entries.has(file) && !(directory && entries.get(file) === null)) {
      throw new Error(`Package entry '${file}' is repeated or conflicts with a directory`);
    }
    if (directory) {
      entries.set(file, null);
      entry.resume();
      return;
    }
    const chunks = [];
    entry.on("end", () => entries.set(file, Buffer.concat(chunks)));
    entry.on("data", (chunk) => chunks.push(chunk));
  };
  parser.on("entry", readEntry);
  parser.on("ignoredEntry", readEntry);
  parser.end(readFileSync(archive));
  // Input exhaustion can silently discard a partial final header, even in strict mode.
  if (!archiveEnded) {
    throw new Error(`Package archive ended before its end-of-archive marker: ${archive}`);
  }
  if (!entries.size) {
    throw new Error(`Package archive must contain only the package directory: ${archive}`);
  }
  for (const [file, contents] of entries) {
    let parent = file;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (Buffer.isBuffer(entries.get(parent))) {
        throw new Error(`Package entry '${parent}' must be a directory to contain '${file}'`);
      }
    }
    if (contents === null) entries.delete(file);
  }
  return entries;
}
