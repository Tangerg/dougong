# External plugin delivery

Platform composes Dougong's public API to manage delivery facts, selection intent, loading, admission and activation. Catalog owns immutable Artifacts; Registration owns selection. Actual running origin is read directly from the Core Installation's `origin`.

```ts
import { createPlatform, MemoryLoader, PermissionSet } from "@dougongjs/platform";

const platform = createPlatform({
  id: "editor-plugins",
  host,
  apiVersion: "1.0.0",
  loader: new MemoryLoader(new Map([["formatter-module", { default: formatter }]])),
  authorizer: new PermissionSet(["workspace:read"]),
});
const artifact = platform.catalog.add({
  revision: "formatter-content-1",
  manifest: {
    name: formatter.name,
    version: "1.0.0",
    permissions: ["workspace:read"],
    activation: ["command:format"],
  },
  reference: "formatter-module",
});
const registration = await platform.select(artifact);
const preview = platform.preview([registration]);
await platform.trigger("command:format");
await platform[Symbol.asyncDispose]();
```

Preview checks declaration data and explicitly lists deferred admission, module validation, configuration validation and Core binding checks. Catalog browsing, selection and preview do not execute plugin code. Lazy activation publishes no executable placeholder. Applications render discoverable Manifest data, activate, then borrow real capabilities.

Authorization has two precise boundaries: `load` before module evaluation, and `activate` after dependencies are ready and immediately before setup. Custom `Authorizer` receives Artifact identity, operation and AbortSignal. Loaders should cooperate with cancellation; a late result from an uncooperative loader cannot commit a superseded selection.

To update, add another Artifact and select it. Selection intent may lead execution. `selectedArtifact` and `activeOrigin` express that difference without copying an additional active Manifest.

```ts
const selected = await platform.select(nextArtifact);
await platform.activate([selected, another], { remove: [obsolete] });
```

Combined additions, updates and removals compile to one Core Plan. `remove` uses the same execution path. Deleting a Catalog entry forgets discovery data; it does not implicitly remove selected or running capabilities.

A separate Host is an assembly boundary. ImportLoader in the same realm is not a permission sandbox. Untrusted-code execution requires a separate process, Worker or WASM executor with explicit permissions, communication and termination protocols.

## Deriving activation from action declarations

Application `ActionDeclaration` data owns command IDs and titles. Examples 08 and 10 derive discoverable metadata, contribution identity and the `actions.map(actionActivation)` list from those same declarations. Setup combines the real handler into each contribution. Triggers call `actionActivation(action)` too, avoiding a second handwritten event list.

A fixed startup policy, requested permissions and version ranges are independent delivery facts and remain explicit. Do not guess runtime protocols from erased TypeScript interfaces.
