import { describe, expect, it, vi } from "vitest";
import {
  createResourceAuthority,
  asyncDisposeSymbol,
  createHost,
  definePlugin,
  disposeSymbol,
  type AnyPlugin,
} from "dougong";
import type { Artifact, Loader } from "@dougongjs/platform";
import { DeploymentController } from "../src/deployment-controller";

const resourceAuthority = createResourceAuthority();

interface ModuleReference {
  readonly default: AnyPlugin;
}

async function createFixture(load: Loader<ModuleReference>["load"] = (reference) => reference) {
  const host = createHost({ resourceAuthority, name: "deployment-controller-test" });
  await host.start();
  const deployment = new DeploymentController({
    id: "deployment",
    host,
    apiVersion: "1.0.0",
    loader: { load },
  });
  const artifact = (name: string, revision: string) =>
    deployment.catalog.add({
      revision,
      manifest: { name, version: "1.0.0" },
      reference: { default: definePlugin({ name, setup() {} }) },
    });
  const commits: Array<{ stateRevision: number; artifacts: string[] }> = [];
  let observedRevision = host.stateRevision;
  const observation = host.diagnostics.subscribe(() => {
    const snapshot = host.diagnostics.get();
    if (snapshot.stateRevision === observedRevision) return;
    observedRevision = snapshot.stateRevision;
    commits.push({
      stateRevision: snapshot.stateRevision,
      artifacts: snapshot.installations
        .map((installation) => `${installation.pluginName}@${installation.origin?.revision}`)
        .sort(),
    });
  });
  return {
    host,
    deployment,
    artifact,
    commits,
    async [asyncDisposeSymbol]() {
      observation[disposeSymbol]();
      try {
        await deployment[asyncDisposeSymbol]();
      } finally {
        await host.stop();
      }
    },
  };
}

describe("deployment requests", () => {
  it("commits concurrent revisions of one Registration in submission order", async () => {
    await using fixture = await createFixture();
    const { deployment, artifact, commits } = fixture;
    const first = artifact("shared", "A");
    const second = artifact("shared", "B");

    const results = await Promise.all([deployment.deploy([first]), deployment.deploy([second])]);

    expect(commits.map((commit) => commit.artifacts)).toEqual([["shared@A"], ["shared@B"]]);
    expect(results.map((result) => result?.stateRevision)).toEqual(
      commits.map((commit) => commit.stateRevision),
    );
    expect(deployment.diagnostics.get().registrations.get("shared")?.activeOrigin?.revision).toBe(
      second.revision,
    );
  });

  it("keeps each concurrent desired set intact through selection and removal", async () => {
    await using fixture = await createFixture();
    const { deployment, artifact, commits } = fixture;
    const first = artifact("common", "A");
    const second = artifact("common", "B");
    const left = artifact("left", "one");
    const right = artifact("right", "one");

    const results = await Promise.all([
      deployment.deploy([first, left]),
      deployment.deploy([second, right]),
    ]);

    expect(commits.map((commit) => commit.artifacts)).toEqual([
      ["common@A", "left@one"],
      ["common@B", "right@one"],
    ]);
    expect(results.map((result) => result?.stateRevision)).toEqual(
      commits.map((commit) => commit.stateRevision),
    );
    expect([...deployment.diagnostics.get().registrations.keys()].sort()).toEqual([
      second.manifest.name,
      right.manifest.name,
    ]);
  });

  it("captures desired artifacts when submitted, before an earlier request finishes", async () => {
    const loading = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const blockedName = "blocked";
    await using fixture = await createFixture(async (reference) => {
      if (reference.default.name === blockedName) {
        loading.resolve();
        await resume.promise;
      }
      return reference;
    });
    const { deployment, artifact, commits } = fixture;
    const blocked = artifact(blockedName, "one");
    const captured = artifact("captured", "one");
    const replacement = artifact("replacement", "one");
    const first = deployment.deploy([blocked]);
    try {
      await loading.promise;
      const desired = [captured];
      const second = deployment.deploy(desired);
      desired[0] = replacement;
      resume.resolve();
      await Promise.all([first, second]);

      expect(commits.map((commit) => commit.artifacts)).toEqual([
        ["blocked@one"],
        ["captured@one"],
      ]);
    } finally {
      resume.resolve();
    }
  });

  it("preserves committed state on failed preparation and continues with the next request", async () => {
    const unavailableName = "unavailable";
    const loadFailure = new Error("module unavailable");
    await using fixture = await createFixture((reference) => {
      if (reference.default.name === unavailableName) throw loadFailure;
      return reference;
    });
    const { deployment, artifact, commits } = fixture;
    const original = artifact("original", "one");
    const unavailable = artifact(unavailableName, "one");
    const replacement = artifact("replacement", "one");
    await deployment.deploy([original]);

    const outcomes = await Promise.allSettled([
      deployment.deploy([unavailable]),
      deployment.deploy([replacement]),
    ]);

    expect(outcomes).toMatchObject([
      { status: "rejected", reason: { code: "MODULE_LOAD_FAILED" } },
      { status: "fulfilled", value: { stateRevision: fixture.host.stateRevision } },
    ]);
    expect(commits.map((commit) => commit.artifacts)).toEqual([
      ["original@one"],
      ["replacement@one"],
    ]);
    expect([...deployment.diagnostics.get().registrations.keys()]).toEqual([
      replacement.manifest.name,
    ]);
  });

  it("rejects duplicate names before selection and preserves activation result semantics", async () => {
    await using fixture = await createFixture();
    const { deployment, artifact, commits } = fixture;
    const first = artifact("shared", "A");
    const second = artifact("shared", "B");

    await expect(deployment.deploy([first, second])).rejects.toThrow(
      "Duplicate selected Registration 'shared'",
    );
    expect(deployment.diagnostics.get().registrations.size).toBe(0);
    await expect(deployment.deploy([first])).resolves.toMatchObject({
      stateRevision: fixture.host.stateRevision + 1,
    });
    await expect(deployment.deploy([first])).resolves.toBeUndefined();
    await expect(deployment.deploy([])).resolves.toMatchObject({
      stateRevision: fixture.host.stateRevision + 1,
    });
    await expect(deployment.deploy([])).resolves.toBeUndefined();
    expect(commits.map((commit) => commit.artifacts)).toEqual([["shared@A"], []]);
    expect(deployment.diagnostics.get().registrations.size).toBe(0);
  });

  it("rejects a later foreign Artifact without changing any earlier selection or commit", async () => {
    await using fixture = await createFixture();
    await using foreign = await createFixture();
    const { deployment, artifact, commits } = fixture;
    const original = artifact("shared", "A");
    const replacement = artifact("shared", "B");
    const outsider = foreign.artifact("outsider", "one");
    await deployment.deploy([original]);
    const before = deployment.diagnostics.get();

    await expect(deployment.deploy([replacement, outsider])).rejects.toMatchObject({
      code: "ARTIFACT_UNAVAILABLE",
    });

    expect(deployment.diagnostics.get()).toBe(before);
    expect(commits.map((commit) => commit.artifacts)).toEqual([["shared@A"]]);
    await deployment.deploy([replacement]);
    expect(commits.map((commit) => commit.artifacts)).toEqual([["shared@A"], ["shared@B"]]);
  });

  it("leaves identity validation to Platform without reading an unowned Artifact", async () => {
    await using fixture = await createFixture();
    const { deployment, artifact, commits } = fixture;
    const first = artifact("first", "one");
    const getter = vi.fn<() => typeof first.manifest>(() => first.manifest);
    const forged = Object.defineProperty({}, "manifest", {
      get: getter,
    }) as Artifact<ModuleReference>;

    await expect(deployment.deploy([first, forged])).rejects.toMatchObject({
      code: "ARTIFACT_UNAVAILABLE",
    });

    expect(getter).not.toHaveBeenCalled();
    expect(deployment.diagnostics.get().registrations.size).toBe(0);
    expect(commits).toEqual([]);
  });

  it("finishes batch selection before a diagnostic observer can withdraw a later Artifact", async () => {
    await using fixture = await createFixture();
    const { deployment, artifact, commits } = fixture;
    const left = artifact("left", "A");
    const right = artifact("right", "A");
    const nextLeft = artifact("left", "B");
    const nextRight = artifact("right", "B");
    await deployment.deploy([left, right]);
    const observed: string[][] = [];
    const subscription = deployment.diagnostics.subscribe(() => {
      const snapshot = deployment.diagnostics.get();
      if (snapshot.registrations.get("left")?.selectedArtifact.revision !== nextLeft.revision)
        return;
      observed.push(
        [...snapshot.registrations.values()].map(
          (registration) => `${registration.name}@${registration.selectedArtifact.revision}`,
        ),
      );
      if (deployment.catalog.get(nextRight.manifest.name, nextRight.revision))
        deployment.catalog.remove(nextRight);
    });
    try {
      await deployment.deploy([nextLeft, nextRight]);

      expect(observed.length).toBeGreaterThan(0);
      for (const selection of observed) expect(selection).toEqual(["left@B", "right@B"]);
      expect(deployment.catalog.get(nextRight.manifest.name, nextRight.revision)).toBeUndefined();
      expect(commits.map((commit) => commit.artifacts)).toEqual([
        ["left@A", "right@A"],
        ["left@B", "right@B"],
      ]);
    } finally {
      subscription[disposeSymbol]();
    }
  });

  it("disposes during loading and rejects queued deployments while leaving Host ownership intact", async () => {
    const loading = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const loadedNames: string[] = [];
    await using fixture = await createFixture(async (reference) => {
      loadedNames.push(reference.default.name);
      loading.resolve();
      await resume.promise;
      return reference;
    });
    const { deployment, artifact, commits } = fixture;
    const first = artifact("first", "one");
    const second = artifact("second", "one");
    const outcomes = Promise.allSettled([deployment.deploy([first]), deployment.deploy([second])]);
    try {
      await loading.promise;
      await deployment[asyncDisposeSymbol]();

      expect(await outcomes).toMatchObject([
        { status: "rejected", reason: { name: "AbortError" } },
        { status: "rejected", reason: { code: "PLATFORM_UNAVAILABLE" } },
      ]);
      expect(loadedNames).toEqual([first.manifest.name]);
      expect(commits).toEqual([]);
      expect(deployment.diagnostics.get().status).toBe("disposed");
      expect(fixture.host.status).toBe("running");
      await expect(deployment.deploy([second])).rejects.toMatchObject({
        code: "PLATFORM_UNAVAILABLE",
      });
    } finally {
      resume.resolve();
    }
  });
});
