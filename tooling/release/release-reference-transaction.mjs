#!/usr/bin/env node

import { readFileSync } from "node:fs";

export const releaseRecordProofFilename = "release-record.json";

if (import.meta.main && process.argv[2] === "prepared") {
  const { reference, head, commit } = JSON.parse(
    readFileSync(new URL(releaseRecordProofFilename, import.meta.url), "utf8"),
  );
  // Git reports the resolved update after locking HEAD and its referent.
  const actual = readFileSync(0, "utf8");
  if (actual !== `${head} ${commit} ${reference}\n`) {
    console.error("Release source reference changed; refusing to record the release");
    process.exitCode = 1;
  }
}
