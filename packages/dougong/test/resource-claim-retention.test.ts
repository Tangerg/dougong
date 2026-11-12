import { expect, it } from "vitest";
import {
  captureResourceAuthority,
  createResourceAuthority,
  type ResourceAuthority,
} from "../src/contracts/resource";

const maximumGarbageCollectionPasses = 8;

async function collect(reference: WeakRef<object>) {
  const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!collectGarbage) throw new TypeError("Retention tests require Node.js --expose-gc");
  for (let pass = 0; pass < maximumGarbageCollectionPasses && reference.deref(); pass++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    collectGarbage();
    collectGarbage();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function releasedClaim(authority: ResourceAuthority) {
  const resource = { [Symbol.dispose]() {} };
  const release = authority.claim(resource);
  release();
  return { release, resource: new WeakRef(resource) };
}

it("detaches the resource from a retained released claim receipt", async () => {
  const { release, resource } = releasedClaim(createResourceAuthority());
  await collect(resource);
  expect(resource.deref()).toBeUndefined();
  expect(release).not.toThrow();
});

function capturedClaim() {
  const payload = {};
  const authority = captureResourceAuthority({
    claim() {
      return () => {
        void payload;
      };
    },
    markControlHandle() {},
  });
  const { release } = releasedClaim(authority);
  return { release, payload: new WeakRef(payload) };
}

it("detaches a structural authority's release callback after successful completion", async () => {
  const { release, payload } = capturedClaim();
  await collect(payload);
  expect(payload.deref()).toBeUndefined();
  expect(release).not.toThrow();
});
