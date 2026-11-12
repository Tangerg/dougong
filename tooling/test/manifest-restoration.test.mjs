import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { executeRelease, releaseTestTimeout } from "./release-fixture.mjs";

const sessionModule = new URL("../release/release-session.mjs", import.meta.url).href;
const commandFixture = new URL("./release-command-fixture.mjs", import.meta.url).href;
const completedScenario = "manifest restoration scenario passed";

async function runRestorationScenario(body) {
  const workspace = mkdtempSync(join(tmpdir(), "dougong-manifest-restoration-test-"));
  for (const name of ["first", "second"]) {
    mkdirSync(join(workspace, name));
    writeFileSync(
      join(workspace, name, "package.json"),
      JSON.stringify({ name, version: "1.0.0" }) + "\n",
    );
  }
  try {
    return await executeRelease(
      [
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import fileSystem from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          import { basename, dirname, join } from "node:path";
          const { installCommandFixture } = await import(${JSON.stringify(commandFixture)});
          const source = { branch: "main", head: "a".repeat(40) };
          const failure = new Error("fixture restoration failure");
          let queryFailure = false;
          let moved = false;
          let queries = 0;
          let onQuery;
          installCommandFixture((command, arguments_) => {
            assert.equal(command, "git");
            assert.equal(arguments_[0], "rev-parse");
            queries++;
            onQuery?.();
            if (queryFailure) return { status: 1, stderr: failure.message };
            return { status: 0, stdout: arguments_.includes("--abbrev-ref") ? (moved ? "another-branch" : source.branch) : source.head };
          });
          const { ReleaseSession } = await import(${JSON.stringify(sessionModule)});
          const session = new ReleaseSession();
          const entries = ["first", "second"].map(name => ({
            name,
            directory: name,
            original: fileSystem.readFileSync(join(name, "package.json")),
            versioned: Buffer.from(JSON.stringify({ name, version: "2.0.0" }) + "\\n"),
          }));
          const outcome = promise => promise.then(
            value => ({ status: "fulfilled", value }),
            reason => ({ status: "rejected", reason }),
          );
          try {
            session.replaceManifests(entries, source);
            ${body}
            console.log(${JSON.stringify(completedScenario)});
          } finally {
            await session.close();
          }
        `,
      ],
      { cwd: workspace, env: process.env },
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

it.each(["source query", "manifest write"])(
  "retains the original failed %s restoration outcome without retrying",
  async (phase) => {
    const result = await runRestorationScenario(`
      let attempts = 0;
      const write = fileSystem.writeFileSync;
      if (${phase === "source query"}) queryFailure = true;
      else {
        fileSystem.writeFileSync = (path, ...arguments_) => {
          if (basename(path) === "package.json" && basename(dirname(dirname(path))) === "first") {
            attempts++;
            throw failure;
          }
          return write(path, ...arguments_);
        };
        syncBuiltinESMExports();
      }
      const first = await outcome(session.restoreManifests());
      assert.equal(first.status, "rejected");
      assert.match(String(first.reason), /restor/);
      const queryCount = queries;
      const attemptCount = attempts;
      queryFailure = false;
      fileSystem.writeFileSync = write;
      syncBuiltinESMExports();
      const second = await outcome(session.restoreManifests());
      assert.equal(second.status, "rejected");
      assert.equal(second.reason, first.reason);
      assert.equal(queries, queryCount);
      assert.equal(attempts, attemptCount);
      assert.throws(() => session.relinquishManifestRestoration(), /after restoration has started/);
      assert(fileSystem.readFileSync("first/package.json").equals(entries[0].versioned));
      assert(fileSystem.readFileSync("second/package.json").equals(${phase === "source query"} ? entries[1].versioned : entries[1].original));
    `);
    expect(result).toMatchObject({
      status: 1,
      stdout: expect.stringContaining(completedScenario),
      stderr: expect.stringContaining("restor"),
    });
  },
  releaseTestTimeout,
);

it(
  "keeps a moved checkout unresolved even when a later caller observes the original source again",
  async () => {
    const result = await runRestorationScenario(`
      moved = true;
      assert.equal(await session.restoreManifests(), false);
      const queryCount = queries;
      moved = false;
      assert.equal(await session.restoreManifests(), false);
      assert.equal(queries, queryCount);
      for (const entry of entries) assert(fileSystem.readFileSync(join(entry.directory, "package.json")).equals(entry.versioned));
    `);
    expect(result).toMatchObject({
      status: 1,
      stdout: expect.stringContaining(completedScenario),
      stderr: expect.stringContaining("Checkout moved"),
    });
  },
  releaseTestTimeout,
);

it(
  "joins in-flight restoration instead of treating its claimed manifests as already restored",
  async () => {
    const result = await runRestorationScenario(`
      const first = session.restoreManifests();
      const second = session.restoreManifests();
      assert.throws(() => session.replaceManifests(entries, source), /ownership has already been established/);
      assert.throws(() => session.relinquishManifestRestoration(), /after restoration has started/);
      let returned = false;
      void second.then(() => { returned = true; });
      await Promise.resolve();
      assert.equal(returned, false);
      assert.deepEqual(await Promise.all([first, second]), [true, true]);
      assert.equal(queries, 2);
      for (const entry of entries) assert(fileSystem.readFileSync(join(entry.directory, "package.json")).equals(entry.original));
      assert.equal(await session.restoreManifests(), true);
      assert.equal(queries, 2);
    `);
    expect(result).toMatchObject({
      status: 0,
      stdout: expect.stringContaining(completedScenario),
      stderr: "",
    });
  },
  releaseTestTimeout,
);

it(
  "rejects restoration during another command without consuming its later restoration attempt",
  async () => {
    const result = await runRestorationScenario(`
      const started = Promise.withResolvers();
      onQuery = started.resolve;
      const command = session.execute("git", ["rev-parse", "HEAD"]);
      await started.promise;
      await assert.rejects(session.restoreManifests(), /before the release command is confirmed stopped/);
      await command;
      onQuery = undefined;
      assert.equal(await session.restoreManifests(), true);
      assert.equal(queries, 3);
      for (const entry of entries) assert(fileSystem.readFileSync(join(entry.directory, "package.json")).equals(entry.original));
    `);
    expect(result).toMatchObject({
      status: 0,
      stdout: expect.stringContaining(completedScenario),
      stderr: "",
    });
  },
  releaseTestTimeout,
);

it(
  "rejects a second replacement batch before it can replace the source of already owned edits",
  async () => {
    const result = await runRestorationScenario(`
      assert.throws(() => session.replaceManifests(entries, { branch: "another-branch", head: "b".repeat(40) }), /ownership has already been established/);
      assert.equal(await session.restoreManifests(), true);
      for (const entry of entries) assert(fileSystem.readFileSync(join(entry.directory, "package.json")).equals(entry.original));
    `);
    expect(result).toMatchObject({
      status: 0,
      stdout: expect.stringContaining(completedScenario),
      stderr: "",
    });
  },
  releaseTestTimeout,
);

it(
  "leaves Git-owned release bytes intact after relinquishing restoration",
  async () => {
    const result = await runRestorationScenario(`
      session.relinquishManifestRestoration();
      assert.equal(await session.restoreManifests(), true);
      assert.throws(() => session.replaceManifests(entries, source), /ownership has already been established/);
      assert.equal(queries, 0);
      for (const entry of entries) assert(fileSystem.readFileSync(join(entry.directory, "package.json")).equals(entry.versioned));
    `);
    expect(result).toMatchObject({
      status: 0,
      stdout: expect.stringContaining(completedScenario),
      stderr: "",
    });
  },
  releaseTestTimeout,
);
