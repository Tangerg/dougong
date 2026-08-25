import {
  createHost,
  createPlatform,
  definePlugin,
  event,
  extensionPoint,
  MemoryLoader,
  PermissionSet,
  service,
  signal,
  type ReadonlySignal,
} from "dougong";
import { exampleResult, whenAborted, type ExampleResult } from "./example";

interface Track {
  readonly query: string;
  readonly uri: string;
  readonly source: string;
}

interface AudioOutput {
  play(uri: string, signal: AbortSignal): Promise<void>;
}

interface MediaSource {
  readonly id: string;
  score(query: string): number;
  resolve(query: string, signal: AbortSignal): Promise<string>;
}

interface Player {
  readonly current: ReadonlySignal<Track | undefined>;
  play(query: string): Promise<void>;
}

const AUDIO_OUTPUT = service<AudioOutput>("examples/planet/audio-output");
const MEDIA_SOURCES = extensionPoint<MediaSource>("examples/planet/media-sources");
const PLAYER = service<Player>("examples/planet/player");
const TRACK_CHANGED = event<Track>("examples/planet/track-changed");

/**
 * The first complete application shape. Nothing new is imported: it is chapters 01–08
 * arranged the way a desktop media application actually needs them.
 */
export async function planetScenario(): Promise<ExampleResult> {
  const audioUris: string[] = [];
  const history: Track[] = [];
  const shellTracks: string[] = [];
  let supersededPlaybacks = 0;
  let playerStarts = 0;
  let player!: Player;

  const audioAdapter = definePlugin({
    name: "examples.planet.adapter.audio",
    provides: { audio: AUDIO_OUTPUT },
    setup: () => ({
      audio: {
        async play(uri: string, signal: AbortSignal) {
          signal.throwIfAborted();
          audioUris.push(uri);
        },
      },
    }),
  });
  const localSource = definePlugin({
    name: "examples.planet.source.local",
    setup(ctx) {
      ctx.contribute(MEDIA_SOURCES, "local", {
        id: "local",
        score: () => 10,
        async resolve(query, signal) {
          signal.throwIfAborted();
          return `file:///music/${query}.flac`;
        },
      });
    },
  });
  const playerPlugin = definePlugin({
    name: "examples.planet.player",
    // `sources` is an ExtensionPoint, so it is a live set rather than a
    // dependency edge. Providers can come and go without restarting the player —
    // that is the fact `playerStarts` measures at the end.
    requires: { audio: AUDIO_OUTPUT, sources: MEDIA_SOURCES },
    provides: { player: PLAYER },
    setup(ctx) {
      playerStarts++;
      const current = signal<Track | undefined>(undefined);
      let playback = ctx.lifetime("playback");

      return {
        player: {
          current,
          async play(query: string) {
            // One child Lifetime per playback. Replacing it aborts whatever the
            // previous track was still doing, without the player owning any
            // cancellation bookkeeping of its own.
            const previous = playback;
            const currentPlayback = ctx.lifetime("playback");
            playback = currentPlayback;
            await previous.dispose();
            // Selection happens per call, from the set as it is right now. There
            // is no registration order, no priority field and no ambient
            // "current provider" — the query decides.
            const source = [...ctx.sources.get().values()].reduce<MediaSource | undefined>(
              (selected, candidate) =>
                !selected || candidate.score(query) > selected.score(query) ? candidate : selected,
              undefined,
            );
            if (!source) throw new Error("No media source is available");
            const uri = await source.resolve(query, currentPlayback.signal);
            await ctx.audio.play(uri, currentPlayback.signal);
            const track = Object.freeze({ query, uri, source: source.id });
            current.set(track);
            await ctx.emit(TRACK_CHANGED, track);
          },
        },
      };
    },
  });
  const historyPlugin = definePlugin({
    name: "examples.planet.history",
    setup(ctx) {
      ctx.on(TRACK_CHANGED, (track) => history.push(track));
    },
  });
  const shellPlugin = definePlugin({
    name: "examples.planet.shell",
    requires: { player: PLAYER },
    setup(ctx) {
      player = ctx.player;
      const synchronize = () => {
        const track = ctx.player.current.get();
        if (track) shellTracks.push(`${track.source}:${track.query}`);
      };
      const subscription = ctx.player.current.subscribe(synchronize);
      ctx.cleanup(() => subscription.dispose());
    },
  });
  const remoteSource = definePlugin({
    name: "examples.planet.source.remote",
    setup(ctx) {
      ctx.contribute(MEDIA_SOURCES, "remote", {
        id: "remote",
        score: () => 100,
        async resolve(query, signal) {
          if (query === "superseded") {
            await whenAborted(signal);
          }
          signal.throwIfAborted();
          return `https://media.example/${encodeURIComponent(query)}`;
        },
      });
    },
  });

  const host = createHost({ name: "planet-example" });
  host.install(audioAdapter);
  host.install(localSource);
  const playerInstallation = host.install(playerPlugin);
  host.install(historyPlugin);
  host.install(shellPlugin);
  // An empty Group, created only to own what arrives later.
  const providers = host.group("providers", () => undefined);
  await host.start();

  // Pointing the Platform at the Group rather than the Host is what makes
  // `providers.remove()` at the end remove every downloaded provider with it.
  const platform = createPlatform({
    installer: providers,
    apiVersion: "1.0.0",
    authorizer: new PermissionSet(["network"]),
    loader: new MemoryLoader(new Map([["remote", { default: remoteSource }]])),
  });
  const remote = await platform.register({
    manifest: {
      name: "examples.planet.source.remote",
      version: "1.0.0",
      activation: ["media:remote"],
      permissions: ["network"],
    },
    reference: "remote",
  });

  // The whole point of the scenario, in eight lines: play with only the local
  // source, activate a better one, start a track that will be interrupted,
  // interrupt it, remove the remote source, and play again.
  await player.play("intro");
  await platform.trigger("media:remote");
  const superseded = player.play("superseded").catch((error: unknown) => {
    if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
    supersededPlaybacks++;
  });
  await player.play("album 42");
  await superseded;
  await remote.remove();
  await player.play("outro");

  const lifetime = host.diagnostics.get().installations.get(playerInstallation.id)?.lifetime?.get();
  await platform.dispose();
  await providers.remove();
  await host.stop();

  return exampleResult({
    id: "09",
    stage: "applications",
    title: "Planet: media providers, playback ownership and call-time selection",
    introduces: ["call-time-selection", "live-provider-swap", "group-bound-platform"],
    facts: [
      `The player picked the best available source each time: ${history.map((track) => track.source).join(" → ")}.`,
      `Audio output received ${audioUris.join(", ")}.`,
      `Providers were added and removed live, yet the player started ${playerStarts} time — an ExtensionPoint is not a dependency edge.`,
      `Replacing playback aborted ${supersededPlaybacks} in-flight resolve through its child Lifetime.`,
      `The shell observed ${shellTracks.join(", ")}; the player kept ${lifetime?.children.length} playback Lifetime, replaced per track.`,
      "The Platform was bound to the /providers Group, so removing that Group removed every downloaded provider with it.",
    ],
  });
}
