import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { differingFile } from "../consumer/package-candidates.mjs";
import { packageArchiveIn, readPackageFiles } from "../package-archive.mjs";

const registryVisibilityTimeoutMinutes = 30;
const millisecondsPerSecond = 1_000;
const millisecondsPerMinute = 60_000;
// Publish-time scanning can exceed fifteen minutes; queries and waits share one budget.
const registryVisibilityTimeoutMilliseconds =
  registryVisibilityTimeoutMinutes * millisecondsPerMinute;
const registryPollIntervalMilliseconds = 15 * millisecondsPerSecond;

function packageScope(name) {
  return name.startsWith("@") ? name.split("/")[0] : undefined;
}

function registryURL(name, raw) {
  const url = typeof raw === "string" ? URL.parse(raw) : null;
  if (
    !url ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    /[?#]/u.test(url.href)
  )
    throw new Error(
      `${name}: npm registry must be an HTTP(S) URL without embedded credentials, query or fragment`,
    );
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export async function captureReleaseRegistry(session, request, allowMovedChannels) {
  const settings = new Map();
  async function setting(key) {
    if (!settings.has(key)) {
      const value = await session.capture("npm", ["config", "get", key], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      settings.set(key, value === "undefined" || !value ? undefined : value);
    }
    return settings.get(key);
  }

  async function resolveRegistry({ name, publishConfig: publishConfiguration }) {
    const scoped = async (scopeName) => {
      if (!scopeName) return undefined;
      if (typeof scopeName !== "string" || !/^@?[^@:/\s]+$/u.test(scopeName))
        throw new Error(`${name}: invalid npm registry scope`);
      const key = scopeName.replace(/^@?/u, "@") + ":registry";
      return publishConfiguration?.[key] ?? (await setting(key));
    };
    const raw =
      (await scoped(packageScope(name))) ??
      (await scoped(publishConfiguration?.scope ?? (await setting("scope")))) ??
      publishConfiguration?.registry ??
      (await setting("registry"));
    return registryURL(name, raw);
  }

  const registries = new Map();
  for (const entry of request.packages) registries.set(entry.name, await resolveRegistry(entry));
  return new ReleaseRegistry(session, request, registries, allowMovedChannels);
}

class ReleaseRegistry {
  #session;
  #request;
  #registries;
  #allowMovedChannels;

  constructor(session, request, registries, allowMovedChannels) {
    this.#session = session;
    this.#request = request;
    this.#registries = registries;
    this.#allowMovedChannels = allowMovedChannels;
  }

  destinationFor(name) {
    return this.#registries.get(name);
  }

  #arguments(name, commandArguments) {
    const registry = this.#registries.get(name);
    const scope = packageScope(name);
    // npm gives a scoped registry priority over --registry; pin both selectors for every command.
    return [
      "--scope=",
      "--registry=" + registry,
      ...(scope ? [`--${scope}:registry=${registry}`] : []),
      ...commandArguments,
    ];
  }

  async authenticate() {
    const authenticated = new Set();
    for (const [name, registry] of this.#registries) {
      if (authenticated.has(registry)) continue;
      const identity = await this.#session.capture("npm", this.#arguments(name, ["whoami"]));
      authenticated.add(registry);
      console.log(`  publishing as ${identity}`);
    }
  }

  async publishedNames() {
    const names = [];
    for (const { name } of this.#request.packages) {
      if (await this.#hasVersion(name)) names.push(name);
    }
    return Object.freeze(names);
  }

  async verifyCandidates(candidates, publishedNames, stage) {
    const present = new Set(publishedNames);
    const verified = [];
    for (const { entry, candidate } of candidates) {
      const canSkipUpload = present.has(entry.name);
      if (canSkipUpload) await this.verifyPublishedPackage(entry, candidate, stage);
      verified.push(Object.freeze({ entry, candidate, canSkipUpload }));
    }
    // Presence alone never authorizes a skip; no result escapes until every existing package matches.
    return Object.freeze(verified);
  }

  async publish(entry, upload) {
    const commandArguments = [
      "publish",
      upload,
      "--access",
      "public",
      `--tag=${entry.distributionTag}`,
    ];
    if (this.#request.oneTimePassword !== undefined)
      commandArguments.push(`--otp=${this.#request.oneTimePassword}`);
    await this.#session.run("npm", this.#arguments(entry.name, commandArguments), {
      interactive: true,
    });
  }

  async assertDistributionTag({ name, distributionTag }) {
    // Channels can move after a completed release; its remote Git tag owns the historical record.
    if (this.#allowMovedChannels) return;
    const version = this.#request.version;
    const tags = JSON.parse(
      await this.#session.capture(
        "npm",
        this.#arguments(name, [
          "view",
          `${name}@${version}`,
          "dist-tags",
          "--prefer-online",
          "--json",
        ]),
      ),
    );
    if (tags?.[distributionTag] !== version)
      throw new Error(
        `${name}@${distributionTag} does not point to ${version}; check the npm channel before resuming`,
      );
  }

  async verifyPublishedPackage(entry, candidate, stage) {
    const { name } = entry;
    const version = this.#request.version;
    const deadline = performance.now() + registryVisibilityTimeoutMilliseconds;
    let announced = false;
    while (true) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0)
        throw new Error(
          `${name}@${version} was not readable within ${registryVisibilityTimeoutMinutes} minutes; processing may still be pending. Re-running \`${this.#request.resumeCommand}\` resumes verification.`,
        );
      const downloaded = mkdtempSync(join(stage, "registry-"));
      try {
        if (await this.#downloadPackage(name, downloaded, remaining)) {
          if (performance.now() > deadline) continue;
          const publishedFiles = readPackageFiles(packageArchiveIn(downloaded));
          const file = differingFile(candidate.files, publishedFiles);
          if (file !== undefined)
            throw new Error(
              `${name}@${version} is published but its ${file} differs from this build; release a new version instead of resuming`,
            );
          await this.assertDistributionTag(entry);
          return;
        }
      } finally {
        rmSync(downloaded, { recursive: true, force: true });
      }
      if (!announced) {
        console.log(`  waiting for ${name}@${version} to become downloadable...`);
        announced = true;
      }
      const remainingAfterRead = Math.floor(deadline - performance.now());
      if (remainingAfterRead <= 0) continue;
      await delay(Math.min(registryPollIntervalMilliseconds, remainingAfterRead), undefined, {
        signal: this.#session.signal,
      });
    }
  }

  async #downloadPackage(name, destination, timeout) {
    const version = this.#request.version;
    const result = await this.#session.execute(
      "npm",
      this.#arguments(name, [
        "pack",
        `${name}@${version}`,
        "--pack-destination",
        destination,
        "--json",
      ]),
      { encoding: "utf8", timeout, killSignal: "SIGKILL" },
    );
    const unavailable = (reason, cause) => {
      throw new Error(`Cannot download ${name}@${version}: ${reason}`, { cause });
    };
    if (result.error) unavailable(result.error.message, result.error);
    if (result.signal) unavailable(`npm pack terminated by ${result.signal}`);
    if (result.status === 0) return true;
    let response;
    try {
      response = JSON.parse(result.stdout);
    } catch (cause) {
      unavailable("npm pack returned invalid JSON", cause);
    }
    // npm can expose version metadata before its immutable tarball reaches the registry edge.
    if (response?.error?.code === "E404") return false;
    unavailable(`npm pack failed (${response?.error?.code ?? result.status})`);
  }

  // Explicit E404 proves absence; every other observation failure leaves publication unknown.
  async #hasVersion(name) {
    const version = this.#request.version;
    const result = await this.#session.execute(
      "npm",
      this.#arguments(name, ["view", `${name}@${version}`, "version", "--prefer-online", "--json"]),
      {
        encoding: "utf8",
        timeout: registryVisibilityTimeoutMilliseconds,
        killSignal: "SIGKILL",
      },
    );
    const unreadable = (reason) => {
      throw new Error(`Cannot determine whether ${name}@${version} is published: ${reason}`);
    };
    if (result.error) unreadable(result.error.message);
    if (result.signal) unreadable(`npm query terminated by ${result.signal}`);
    let response;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      unreadable("npm query returned invalid JSON");
    }
    if (result.status === 0) {
      if (response !== version) unreadable("npm query returned an unexpected version");
      return true;
    }
    if (response?.error?.code === "E404") return false;
    unreadable(`npm query failed (${response?.error?.code ?? result.status})`);
  }
}
