import { DougongError, groupConflictCode, groupMissingCode } from "../contracts/errors.js";
import { captureLogger, type Logger } from "../contracts/logging.js";
import { buildInitialGroups, type GroupNode } from "../composition/group.js";
import type { HostIdentities } from "../composition/identities.js";
import {
  captureInstallationDeclaration,
  claimInstallationId,
  type InstallationDeclaration,
  type InstallationRecord,
} from "../composition/installation.js";
import type { InitialInstallation } from "../composition/declarations.js";
import { captureDataArray } from "../internal/data-array.js";
import { normalizePlainRecord, recordFields } from "../internal/record.js";
import { assertTrimmedText } from "../internal/text.js";
import { captureTimerDelay } from "../internal/timer.js";
import type { HostOptions } from "./host-api.js";
import { captureResourceAuthority, type ResourceAuthority } from "../contracts/resource.js";

const defaultHostName = "host";

type InitialGroup = NonNullable<HostOptions["groups"]>[number];

const hostOptionFields = recordFields<HostOptions>()(
  "resourceAuthority",
  "name",
  "installations",
  "groups",
  "logger",
  "onError",
  "shutdownTimeoutMilliseconds",
  "restorationTimeoutMilliseconds",
);
const initialGroupFields = recordFields<InitialGroup>()("id", "parentId");
const initialInstallationFields = recordFields<InitialInstallation>()(
  "id",
  "plugin",
  "configuration",
  "origin",
  "groupId",
);

export interface CapturedHostOptions {
  readonly resourceAuthority: ResourceAuthority;
  readonly name: string;
  readonly logger: Logger<unknown>;
  readonly onError: ((error: unknown) => unknown) | undefined;
  readonly shutdownTimeoutMilliseconds: number | undefined;
  readonly restorationTimeoutMilliseconds: number | undefined;
  readonly groups: ReadonlyMap<string, GroupNode>;
  readonly declarations: ReadonlyMap<InstallationRecord, InstallationDeclaration>;
}

// Defaults apply only to omitted options; an explicit null is rejected like any other invalid value.
export function captureHostOptions(
  options: HostOptions,
  identities: HostIdentities,
): CapturedHostOptions {
  const input = normalizePlainRecord(options, "Host options", { fields: hostOptionFields });
  const resourceAuthority = captureResourceAuthority(input.resourceAuthority);
  const name = input.name === undefined ? defaultHostName : input.name;
  assertTrimmedText(name, "Host name");
  if (input.onError !== undefined && typeof input.onError !== "function")
    throw new TypeError("Host onError must be a function");
  const logger = captureLogger(input.logger === undefined ? console : input.logger);
  const shutdownTimeoutMilliseconds = captureTimerDelay(
    input.shutdownTimeoutMilliseconds,
    "shutdownTimeoutMilliseconds",
  );
  const restorationTimeoutMilliseconds = captureTimerDelay(
    input.restorationTimeoutMilliseconds,
    "restorationTimeoutMilliseconds",
  );
  const initialGroups = captureDataArray(
    input.groups === undefined ? [] : input.groups,
    "Initial Groups",
  );
  const initialInstallations = captureDataArray(
    input.installations === undefined ? [] : input.installations,
    "Initial Installations",
  );
  const groups = captureInitialGroups(initialGroups, identities);
  const declarations = captureInitialInstallations(initialInstallations, groups, identities);
  return Object.freeze({
    resourceAuthority,
    name,
    logger,
    onError: input.onError as ((error: unknown) => unknown) | undefined,
    shutdownTimeoutMilliseconds,
    restorationTimeoutMilliseconds,
    groups,
    declarations,
  });
}

function captureInitialGroups(input: ReadonlyArray<InitialGroup>, identities: HostIdentities) {
  const parents = new Map<string, string | undefined>();
  for (const raw of input) {
    const group = normalizePlainRecord(raw, "Initial Group", { fields: initialGroupFields });
    assertTrimmedText(group.id, "Group id");
    if (group.parentId !== undefined) assertTrimmedText(group.parentId, "Parent Group id");
    if (parents.has(group.id))
      throw new DougongError(groupConflictCode, "Duplicate initial Group: " + group.id);
    parents.set(group.id, group.parentId as string | undefined);
  }
  return buildInitialGroups(parents, (id, parent) => identities.createGroup(id, parent));
}

function captureInitialInstallations(
  input: ReadonlyArray<InitialInstallation>,
  groups: ReadonlyMap<string, GroupNode>,
  identities: HostIdentities,
) {
  const declarations = new Map<InstallationRecord, InstallationDeclaration>();
  const ids = new Set<string>();
  for (const raw of input) {
    const initial = normalizePlainRecord(raw, "Initial Installation", {
      fields: initialInstallationFields,
    });
    assertTrimmedText(initial.id, "Installation id");
    if (initial.groupId !== undefined) assertTrimmedText(initial.groupId, "Installation Group id");
    claimInstallationId(ids, initial.id);
    const group = initial.groupId === undefined ? undefined : groups.get(initial.groupId);
    if (initial.groupId !== undefined && !group)
      throw new DougongError(groupMissingCode, "Initial Group is missing: " + initial.groupId);
    declarations.set(
      identities.createInstallation(initial.id, group),
      captureInstallationDeclaration(initial.plugin, initial.configuration, initial.origin),
    );
  }
  return declarations;
}
