import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Header, Pax } from "tar";
import { afterEach, expect, it } from "vitest";
import { readPackageFiles } from "../release-archive.mjs";

const workspaces = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function archive(members, transform = (bytes) => bytes) {
  const blocks = [];
  for (const { contents = "", extended, ...fields } of members) {
    const bytes = Buffer.from(contents);
    const header = new Header({ type: "File", size: bytes.length, ...fields });
    header.encode();
    if (extended) blocks.push(new Pax(extended).encode());
    blocks.push(header.block, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const workspace = mkdtempSync(join(tmpdir(), "dougong-release-archive-test-"));
  workspaces.push(workspace);
  const path = join(workspace, "package.tgz");
  writeFileSync(path, gzipSync(transform(Buffer.concat(blocks))));
  return path;
}

it("preserves file names and bytes without a filesystem projection", () => {
  const files = readPackageFiles(
    archive([
      { path: "package/", type: "Directory" },
      { path: "package/dist/index.js", contents: "export {};" },
      { path: "package/README.md", contents: "upper" },
      { path: "package/readme.md", contents: "lower" },
      { path: "package/a\nother.txt", contents: Buffer.from([0xff, 0x00, 0x01]) },
      { path: "package/empty", contents: "" },
    ]),
  );
  expect(files).toEqual(
    new Map([
      ["dist/index.js", Buffer.from("export {};")],
      ["README.md", Buffer.from("upper")],
      ["readme.md", Buffer.from("lower")],
      ["a\nother.txt", Buffer.from([0xff, 0x00, 0x01])],
      ["empty", Buffer.alloc(0)],
    ]),
  );
});

it("reads extended paths while excluding archive metadata and empty directories", () => {
  const path = `dist/${"long-name-".repeat(20)}.js`;
  const files = readPackageFiles(
    archive([
      { path: "package/unused/", type: "Directory" },
      { path: "package/unused/", type: "Directory" },
      {
        path: `package/${"prefix/".repeat(20)}short.js`,
        extended: { path: `package/${path}` },
        contents: "long",
      },
    ]),
  );
  expect(files).toEqual(new Map([[path, Buffer.from("long")]]));
});

it.each([
  "./package/file",
  "/package/file",
  "other/file",
  "package/../file",
  "package/./file",
  "package//file",
  "package/folder\\file",
])("rejects an ambiguous or outside member path %s", (path) => {
  expect(() => readPackageFiles(archive([{ path, contents: "data" }]))).toThrow(
    /package directory|canonical path/,
  );
});

it("validates the effective path from an extended header", () => {
  expect(() =>
    readPackageFiles(
      archive([{ path: "package/file", extended: { path: "other/file" }, contents: "data" }]),
    ),
  ).toThrow("Package archive must contain only the package directory");
});

it.each(["Link", "SymbolicLink", "FIFO", "CharacterDevice", "ContiguousFile", "SparseFile"])(
  "rejects %s entries instead of ignoring or converting them to files",
  (type) => {
    expect(() =>
      readPackageFiles(
        archive([
          { path: "package/target", contents: "data" },
          {
            path: "package/entry",
            type,
            ...(["Link", "SymbolicLink"].includes(type) ? { linkpath: "package/target" } : {}),
          },
        ]),
      ),
    ).toThrow("must be a regular file");
  },
);

it("rejects a file occupying the package root", () => {
  expect(() => readPackageFiles(archive([{ path: "package", contents: "data" }]))).toThrow(
    "Package root must be a directory",
  );
});

it("rejects repeated file members even when the last one looks correct", () => {
  expect(() =>
    readPackageFiles(
      archive([
        { path: "package/file", contents: "earlier" },
        { path: "package/file", contents: "later" },
      ]),
    ),
  ).toThrow("is repeated or conflicts with a directory");
});

it.each([false, true])("rejects file and directory conflicts (reverse: %s)", (reverse) => {
  const members = [
    { path: "package/file", contents: "data" },
    { path: "package/file/", type: "Directory" },
  ];
  expect(() => readPackageFiles(archive(reverse ? members.reverse() : members))).toThrow(
    "is repeated or conflicts with a directory",
  );
});

it.each([false, true])(
  "rejects file ancestors without explicit directories (reverse: %s)",
  (reverse) => {
    const members = [
      { path: "package/file", contents: "data" },
      { path: "package/file/child", contents: "child" },
    ];
    expect(() => readPackageFiles(archive(reverse ? members.reverse() : members))).toThrow(
      "must be a directory to contain",
    );
  },
);

it("rejects a truncated file body instead of returning a partial snapshot", () => {
  expect(() =>
    readPackageFiles(
      archive([{ path: "package/file", contents: "data" }], (bytes) => bytes.subarray(0, 514)),
    ),
  ).toThrow("Truncated input");
});

it.each([
  { missing: "part of the final header", end: 1280 },
  { missing: "both end blocks", end: -1024 },
  { missing: "the second end block", end: -512 },
])("rejects an archive missing $missing", ({ end }) => {
  expect(() =>
    readPackageFiles(
      archive(
        [
          { path: "package/first", contents: "first" },
          { path: "package/second", contents: "second" },
        ],
        (bytes) => bytes.subarray(0, end),
      ),
    ),
  ).toThrow("Package archive ended before its end-of-archive marker");
});

it("rejects a damaged header rather than omitting the entry", () => {
  expect(() =>
    readPackageFiles(
      archive([{ path: "package/file", contents: "data" }], (bytes) => {
        bytes[0] ^= 1;
        return bytes;
      }),
    ),
  ).toThrow("checksum failure");
});

it("rejects an archive with no package entries", () => {
  expect(() => readPackageFiles(archive([]))).toThrow("Unrecognized archive format");
});
