import { DougongError, quarantinedHost, changeForeignCode } from "../contracts/errors.js";
import { captureConfiguration, type ConfigurationValue } from "./configuration.js";
import { normalizePlugin, type AnyPlugin, type NormalizedPlugin } from "./plugin.js";
import { normalizePlainRecord, recordFields } from "../internal/record.js";
import { assertTrimmedText } from "../internal/text.js";
import type {
  ChangeSet,
  Group,
  Installation,
  InstallationArguments,
  InstallationOptions,
  InstallationOrigin,
  InstallationUpdate,
} from "./declarations.js";
import {
  PendingInstallations,
  captureInstallationDeclaration,
  captureOrigin,
  type InstallationDeclaration,
  type InstallationRecord,
} from "./installation.js";
import type { GroupNode } from "./group.js";

const installationOptionFields = recordFields<InstallationOptions>()(
  "id",
  "configuration",
  "origin",
  "group",
);
const installationUpdateFields = recordFields<InstallationUpdate>()(
  "plugin",
  "configuration",
  "origin",
);

export type NormalizedInstallationUpdate =
  | {
      readonly kind: "replace";
      readonly plugin: NormalizedPlugin;
      readonly configuration?: ConfigurationValue | undefined;
      readonly origin: InstallationOrigin | undefined;
    }
  | {
      readonly kind: "configure";
      readonly configuration: ConfigurationValue | undefined;
      readonly plugin?: never;
      readonly origin?: never;
    };

export type ChangeOperation =
  | {
      readonly kind: "install";
      readonly installation: InstallationRecord;
      readonly declaration: InstallationDeclaration;
    }
  | {
      readonly kind: "update";
      readonly installation: InstallationRecord;
      readonly update: NormalizedInstallationUpdate;
    }
  | { readonly kind: "remove"; readonly installation: InstallationRecord }
  | { readonly kind: "group"; readonly group: GroupNode }
  | { readonly kind: "removeGroup"; readonly group: GroupNode };

export interface ChangePort {
  readonly createInstallation: (id: string, group: GroupNode | undefined) => InstallationRecord;
  readonly resolveInstallation: (installation: object) => InstallationRecord;
  readonly createGroup: (id: string, parent: GroupNode | undefined) => GroupNode;
  readonly resolveGroup: (group: object) => GroupNode;
}

interface DraftState {
  readonly port: ChangePort;
  readonly operations: ChangeOperation[];
  readonly targets: Set<object>;
}

type ChangeSetsState =
  | { readonly phase: "open"; readonly drafts: WeakMap<ChangeSet, DraftState> }
  | { readonly phase: "closed"; readonly revision: number };

export class ChangeSets {
  #state: ChangeSetsState = { phase: "open", drafts: new WeakMap() };
  readonly #pending = new PendingInstallations();

  create(port: ChangePort): ChangeSet {
    const draft = new ChangeSetDraft(this);
    this.#drafts().set(draft.handle, { port, operations: [], targets: new Set() });
    return draft.handle;
  }

  take(change: ChangeSet): ReadonlyArray<ChangeOperation> {
    const drafts = this.#drafts();
    const state = drafts.get(change);
    if (!state)
      throw new DougongError(
        changeForeignCode,
        "ChangeSet belongs to another Host or was already planned",
      );
    drafts.delete(change);
    return Object.freeze(state.operations);
  }

  requireOpen(change: ChangeSet) {
    const state = this.#drafts().get(change);
    if (!state) throw new TypeError("ChangeSet has already been planned");
    return state;
  }

  track(installation: InstallationRecord) {
    this.#pending.attach(installation);
  }

  close(revision: number) {
    this.#state = { phase: "closed", revision };
    this.#pending.retire();
  }

  #drafts() {
    const state = this.#state;
    if (state.phase === "closed") throw quarantinedHost(state.revision);
    return state.drafts;
  }
}

class ChangeSetDraft {
  readonly #authority: ChangeSets;
  readonly handle: ChangeSet = Object.freeze({
    install: this.install.bind(this),
    update: this.update.bind(this),
    remove: this.remove.bind(this),
    group: this.group.bind(this),
    removeGroup: this.removeGroup.bind(this),
  });

  constructor(authority: ChangeSets) {
    this.#authority = authority;
    Object.freeze(this);
  }

  install<Arguments extends readonly [plugin: AnyPlugin, options: unknown]>(
    ...[plugin, options]: Arguments & NoInfer<InstallationArguments<Arguments[0]>>
  ): Installation<Arguments[0]> {
    const { port } = this.#requireOpen();
    const input = normalizePlainRecord(options, "Installation options", {
      fields: installationOptionFields,
    });
    assertTrimmedText(input.id, "Installation id");
    const group = input.group === undefined ? undefined : port.resolveGroup(input.group as object);
    const declaration = captureInstallationDeclaration(plugin, input.configuration, input.origin);
    this.#requireOpen();
    const installation = port.createInstallation(input.id, group);
    this.#stage(installation, { kind: "install", installation, declaration });
    return installation.facade as unknown as Installation<Arguments[0]>;
  }

  update(installation: object, update: unknown) {
    const { port } = this.#requireOpen();
    const input = normalizePlainRecord(update, "Installation update", {
      fields: installationUpdateFields,
    });
    const hasPlugin = Object.hasOwn(input, "plugin");
    const hasConfiguration = Object.hasOwn(input, "configuration");
    if (!hasPlugin && !hasConfiguration)
      throw new TypeError("Installation update requires plugin or configuration");
    if (!hasPlugin && Object.hasOwn(input, "origin"))
      throw new TypeError("Origin can only change with its Plugin");
    const replacement: NormalizedInstallationUpdate = hasPlugin
      ? {
          kind: "replace",
          plugin: normalizePlugin(input.plugin),
          origin: captureOrigin(input.origin),
          ...(hasConfiguration ? { configuration: captureConfiguration(input.configuration) } : {}),
        }
      : { kind: "configure", configuration: captureConfiguration(input.configuration) };
    const record = port.resolveInstallation(installation);
    this.#stage(record, {
      kind: "update",
      installation: record,
      update: Object.freeze(replacement),
    });
  }

  remove<Declaration extends AnyPlugin>(installation: Installation<Declaration>) {
    const record = this.#requireOpen().port.resolveInstallation(installation);
    this.#stage(record, { kind: "remove", installation: record });
  }

  group(id: string, parent?: Group) {
    const { port } = this.#requireOpen();
    assertTrimmedText(id, "Group id");
    const group = port.createGroup(
      id,
      parent === undefined ? undefined : port.resolveGroup(parent),
    );
    this.#stage(group, { kind: "group", group });
    return group.facade;
  }

  removeGroup(group: Group) {
    const record = this.#requireOpen().port.resolveGroup(group);
    this.#stage(record, { kind: "removeGroup", group: record });
  }

  #stage(target: object, operation: ChangeOperation) {
    const { targets, operations } = this.#requireOpen();
    if (targets.has(target)) throw new TypeError("A target can appear only once in a ChangeSet");
    if (operation.kind === "install") this.#authority.track(operation.installation);
    targets.add(target);
    operations.push(Object.freeze(operation));
  }

  #requireOpen() {
    return this.#authority.requireOpen(this.handle);
  }
}
