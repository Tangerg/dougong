import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";

const terminationSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
const maximumCapturedBytes = 1024 * 1024;
const commandTerminationGraceMilliseconds = 2_000;
const commandTerminationConfirmationMilliseconds = 250;
const commandGroupPollMilliseconds = 25;
const interruptCommand = "interrupt";
const settleCommand = "settle";
const ignoreCancellation = "ignore";

class ReleaseCancellation extends Error {
  constructor(signal) {
    super(`Release interrupted by ${signal}`);
    this.signal = signal;
  }
}

export class ReleaseSession {
  #cancellation = new AbortController();
  #command;
  #manifestTransaction = { phase: "unclaimed" };
  #stage;

  constructor() {
    for (const signal of terminationSignals) process.on(signal, this.#cancel);
  }

  get signal() {
    return this.#cancellation.signal;
  }

  #cancel = (signal) => {
    if (!this.signal.aborted) this.#cancellation.abort(new ReleaseCancellation(signal));
    else this.#command?.forceStop?.();
  };

  async execute(command, commandArguments, options = {}) {
    return this.#execute(command, commandArguments, options);
  }

  async run(command, commandArguments, options = {}) {
    const result = await this.execute(command, commandArguments, { stdio: "inherit", ...options });
    assertCommandSucceeded(command, commandArguments, result);
    return result;
  }

  async capture(command, commandArguments, options = {}) {
    const result = await this.run(command, commandArguments, {
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
      ...options,
    });
    return result.stdout.trim();
  }

  async #execute(command, commandArguments, options, cancellation = interruptCommand) {
    // A signal received during synchronous archive inspection must be delivered before another command starts.
    await nextTurn();
    if (cancellation !== ignoreCancellation) this.signal.throwIfAborted();
    if (this.#command) throw new Error("A release command is already running");

    const {
      encoding,
      stdio = "pipe",
      timeout = 0,
      killSignal = "SIGTERM",
      interactive = false,
      ...spawnOptions
    } = options;
    if (interactive && timeout > 0)
      throw new TypeError("Interactive release commands cannot enforce an output deadline");
    const descriptors = Array.isArray(stdio) ? stdio : [stdio, stdio, stdio];
    const failures = [];
    let child;
    let termination = { phase: "running" };
    const { promise: forceRequested, resolve: resolveForceRequested } = Promise.withResolvers();
    const terminate = (signal) => {
      if (child?.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") failures.push(error);
      }
    };
    const groupExists = () => {
      if (child?.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        if (error.code === "EPERM") return true;
        failures.push(error);
        return true;
      }
    };
    const forceStop = () => {
      if (termination.phase !== "running" && termination.phase !== "interrupting") return;
      clearTimeout(termination.timer);
      termination = { phase: "killing" };
      terminate("SIGKILL");
      resolveForceRequested();
    };
    const interrupt = (signal) => {
      if (signal === "SIGKILL") return forceStop();
      if (termination.phase !== "running") return;
      termination = {
        phase: "interrupting",
        timer: setTimeout(forceStop, commandTerminationGraceMilliseconds),
      };
      terminate(signal);
    };
    const cancel = () => interrupt(this.signal.reason.signal);
    // The command group can still own output after its leader exits; its deadline belongs to this same join.
    const deadlineTimer =
      timeout > 0
        ? setTimeout(() => {
            failures.push(
              Object.assign(new Error(`${command} timed out after ${timeout} ms (ETIMEDOUT)`), {
                code: "ETIMEDOUT",
              }),
            );
            interrupt(killSignal);
          }, timeout)
        : undefined;
    let result;
    try {
      child = spawn(command, commandArguments, {
        ...spawnOptions,
        detached: true,
        // Publication needs real terminal descriptors for npm's browser authentication.
        // Queries retain pipes so their deadlines include descendants that still own output.
        stdio: interactive
          ? descriptors
          : [descriptors[0] === "inherit" ? "inherit" : "ignore", "pipe", "pipe"],
      });
      const output = ["stdout", "stderr"].map((channel, index) => {
        if (child[channel] === null) return () => null;
        const chunks = [];
        let length = 0;
        const disposition = descriptors[index + 1];
        if (disposition === "inherit") child[channel].pipe(process[channel], { end: false });
        else if (disposition === "pipe") {
          child[channel].on("data", (bytes) => {
            length += bytes.length;
            if (length <= maximumCapturedBytes) chunks.push(bytes);
            else if (length - bytes.length <= maximumCapturedBytes) {
              failures.push(
                new Error(`${command} ${channel} exceeded ${maximumCapturedBytes} bytes`),
              );
              forceStop();
            }
          });
        } else child[channel].resume();
        return () => {
          if (descriptors[index + 1] !== "pipe") return null;
          const bytes = Buffer.concat(chunks);
          return encoding ? bytes.toString(encoding) : bytes;
        };
      });
      const completion = new Promise((resolveCompletion) => {
        child.on("error", (error) => failures.push(error));
        child.once("close", (status, signal) => {
          resolveCompletion({ status, signal });
        });
      }).then(async (outcome) => {
        await nextTurn();
        // A leader's closed output does not discharge descendants that still own release files.
        while (termination.phase === "running" && groupExists())
          await delay(commandGroupPollMilliseconds);
        if (termination.phase !== "running" && groupExists()) {
          await forceRequested;
          await delay(commandTerminationConfirmationMilliseconds);
          if (groupExists()) {
            const error = new Error(
              `Release command group ${child.pid} could not be confirmed stopped after SIGKILL`,
            );
            failures.push(error);
            termination = { phase: "retained", error };
          }
        }
        if (termination.phase !== "retained") {
          clearTimeout(termination.timer);
          termination = { phase: "closed" };
        }
        return {
          ...outcome,
          stdout: output[0](),
          stderr: output[1](),
          error:
            failures.length > 1 ? new AggregateError(failures, `${command} failed`) : failures[0],
        };
      });
      // A ref transaction owns its settlement; ambient cancellation cannot authorize interrupting it.
      this.#command = {
        completion,
        get retainedFailure() {
          return termination.phase === "retained" ? termination.error : undefined;
        },
        ...(cancellation === interruptCommand ? { interrupt, forceStop } : {}),
      };
      if (cancellation === interruptCommand)
        this.signal.addEventListener("abort", cancel, { once: true });
      result = await completion;
    } finally {
      clearTimeout(deadlineTimer);
      clearTimeout(termination.timer);
      this.signal.removeEventListener("abort", cancel);
      if (termination.phase !== "retained") this.#command = undefined;
    }
    await nextTurn();
    if (cancellation === interruptCommand) {
      if (this.signal.aborted && result.error) {
        throw new AggregateError([this.signal.reason, result.error], "Release command interrupted");
      }
      this.signal.throwIfAborted();
    }
    return result;
  }

  async atSource(source) {
    return this.#atSource(source, interruptCommand);
  }

  async #atSource({ branch, head }, cancellation) {
    const query = async (commandArguments) => {
      const result = await this.#execute(
        "git",
        commandArguments,
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        cancellation,
      );
      assertCommandSucceeded("git", commandArguments, result);
      return result.stdout.trim();
    };
    return (
      (await query(["rev-parse", "--abbrev-ref", "HEAD"])) === branch &&
      (await query(["rev-parse", "HEAD"])) === head
    );
  }

  replaceManifests(entries, source) {
    this.signal.throwIfAborted();
    if (this.#manifestTransaction.phase !== "unclaimed")
      throw new Error("Release manifest ownership has already been established");
    const ownership = { source, entries: new Set() };
    this.#manifestTransaction = { phase: "owned", ownership };
    for (const entry of entries) {
      replaceManifest(entry.directory, entry.original, entry.versioned, () =>
        ownership.entries.add(entry),
      );
      console.log(`  ${entry.name} → ${JSON.parse(entry.versioned).version}`);
    }
  }

  async restoreManifests() {
    const state = this.#manifestTransaction;
    if (state.phase === "restoration") return state.completion;
    if (this.#command)
      throw new Error("Cannot restore manifests before the release command is confirmed stopped");
    if (state.phase !== "owned") return true;
    // Reserve one restoration before source inspection yields; unfinished edits retain their owner and outcome.
    const completion = Promise.resolve().then(() => this.#restoreManifests(state.ownership));
    this.#manifestTransaction = { phase: "restoration", ownership: state.ownership, completion };
    return completion;
  }

  async #restoreManifests(ownership) {
    const owned = [...ownership.entries];
    if (!owned.length) return true;
    // Cancellation stops publication, not the read-only Git check needed to respect another checkout owner.
    if (!(await this.#atSource(ownership.source, ignoreCancellation))) return false;
    const errors = [];
    for (const entry of owned) {
      const { directory, original, versioned } = entry;
      try {
        if (readFileSync(manifestPath(directory)).equals(original)) ownership.entries.delete(entry);
        else replaceManifest(directory, versioned, original, () => ownership.entries.delete(entry));
      } catch (cause) {
        errors.push(new Error(`Could not restore ${directory}/package.json`, { cause }));
      }
    }
    if (errors.length) throw new AggregateError(errors, "Release manifest restoration failed");
    return true;
  }

  relinquishManifestRestoration() {
    if (this.#manifestTransaction.phase === "restoration")
      throw new Error("Cannot relinquish manifests after restoration has started");
    this.#manifestTransaction = { phase: "relinquished" };
  }

  async recordCommit({ source, reference, commit, directory, message }, indexProjection) {
    const commandArguments = [
      "-c",
      `core.hooksPath=${directory}`,
      "update-ref",
      "-m",
      message,
      "HEAD",
      commit,
      source.head,
    ];
    // The private prepared hook authorizes the locked ref; cancellation must join its index projection.
    const result = await this.#execute(
      "git",
      commandArguments,
      {
        stdio: "pipe",
        env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` },
      },
      settleCommand,
    );
    const failures = [];
    try {
      assertCommandSucceeded("git", commandArguments, result);
    } catch (error) {
      failures.push(error);
    }
    const query = async (arguments_) => {
      try {
        const observed = await this.#execute(
          "git",
          arguments_,
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          ignoreCancellation,
        );
        assertCommandSucceeded("git", arguments_, observed);
        return observed.stdout.trim();
      } catch (error) {
        failures.push(error);
        return undefined;
      }
    };
    const observedReference = await query(["rev-parse", "--verify", reference]);
    const checkoutReference =
      observedReference === commit ? await query(["symbolic-ref", "--quiet", "HEAD"]) : undefined;
    const recoveryMessage =
      `Release reference ${reference} requires inspection (source ${source.head}, release ${commit}, ` +
      `observed ${observedReference ?? "unavailable"}); prepared index retained at ${indexProjection.path}. ` +
      "Inspect the checkout and reconcile the retained index before resuming.";
    if (observedReference === commit && checkoutReference === reference) {
      this.relinquishManifestRestoration();
      try {
        indexProjection.publish();
      } catch (cause) {
        indexProjection.retain();
        failures.push(new Error(recoveryMessage, { cause }));
      }
    } else if (!(failures.length && observedReference === source.head)) {
      // An uncertain or superseded ref update cannot authorize restoring the old worktree or projecting this index.
      this.relinquishManifestRestoration();
      indexProjection.retain();
      failures.push(new Error(recoveryMessage));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Release recording failed");
    this.signal.throwIfAborted();
  }

  createStage() {
    this.signal.throwIfAborted();
    if (this.#stage !== undefined) throw new Error("Release staging directory already exists");
    this.#stage = mkdtempSync(join(tmpdir(), "dougong-release-"));
    return this.#stage;
  }

  retainStage() {
    this.signal.throwIfAborted();
    this.#stage = undefined;
  }

  async close() {
    await nextTurn();
    const command = this.#command;
    if (command) {
      command.interrupt?.(this.signal.reason?.signal ?? "SIGTERM");
      await command.completion;
    }
    if (command?.retainedFailure) {
      const manifests = [...(this.#manifestTransaction.ownership?.entries ?? [])].map(
        ({ directory }) => `${directory}/package.json`,
      );
      console.error(
        new Error(
          `Release cleanup withheld: ${command.retainedFailure.message}. ` +
            `Retained stage: ${this.#stage ?? "none"}; manifests: ${manifests.join(", ") || "none"}. ` +
            "Confirm the process group has exited before restoring manifests or removing the stage.",
        ),
      );
      process.exitCode = 1;
    } else {
      await this.#cleanFiles();
    }
    await nextTurn();
    for (const signal of terminationSignals) process.removeListener(signal, this.#cancel);
    if (this.signal.aborted) process.kill(process.pid, this.signal.reason.signal);
  }

  async #cleanFiles() {
    try {
      if (!(await this.restoreManifests())) {
        throw new Error(
          "Checkout moved; leaving manifests untouched. Inspect Git before resuming.",
        );
      }
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
    if (this.#stage !== undefined) {
      try {
        rmSync(this.#stage, { recursive: true, force: true });
        this.#stage = undefined;
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      }
    }
  }
}

function assertCommandSucceeded(command, commandArguments, result) {
  if (result.error)
    throw new Error(`${command} could not complete: ${result.error.message}`, {
      cause: result.error,
    });
  if (result.status !== 0) {
    const outcome = result.signal ? `signal ${result.signal}` : String(result.status);
    const detail = result.stderr?.length ? `\n${result.stderr}` : "";
    throw new Error(`${command} ${commandArguments[0]} exited with ${outcome}${detail}`);
  }
}

export function manifestPath(directory) {
  if (
    !lstatSync(directory).isDirectory() ||
    realpathSync(directory) !== join(realpathSync("."), directory)
  ) {
    throw new Error(`Package root must be a directory inside this workspace: ${directory}`);
  }
  const file = resolve(directory, "package.json");
  if (!lstatSync(file).isFile())
    throw new Error(`Release manifest must be a regular file: ${file}`);
  return file;
}

function replaceManifest(directory, expected, replacement, onReplaced) {
  const path = manifestPath(directory);
  const temporary = mkdtempSync(join(dirname(path), ".release-manifest-"));
  try {
    const file = join(temporary, "package.json");
    writeFileSync(file, replacement);
    chmodSync(file, statSync(path).mode);
    if (!readFileSync(manifestPath(directory)).equals(expected)) {
      throw new Error(
        `${directory}/package.json changed during release; preserving external edits`,
      );
    }
    renameSync(file, path);
    onReplaced?.();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
