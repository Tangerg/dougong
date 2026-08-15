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
import { exampleResult, type ExampleResult } from "./example";

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
 * The first real host shape. Nothing new is imported: it is chapters 01–08
 * arranged the way a desktop media application actually needs them.
 */
export async function planetScenario(): Promise<ExampleResult> {
  const audioUris: string[] = [];
  const history: Track[] = [];
  const shellTracks: string[] = [];
  let playerStarts = 0;
  let player!: Player;

  const audioAdapter = definePlugin({
    name: "examples.planet.host.audio",
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
            await playback.dispose();
            playback = ctx.lifetime("playback");
            const source = [...ctx.sources.get().values()].reduce<MediaSource | undefined>(
              (selected, candidate) =>
                !selected || candidate.score(query) > selected.score(query) ? candidate : selected,
              undefined,
            );
            if (!source) throw new Error("No media source is available");
            const uri = await source.resolve(query, playback.signal);
            await ctx.audio.play(uri, playback.signal);
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
          signal.throwIfAborted();
          return `https://media.example/${encodeURIComponent(query)}`;
        },
      });
    },
  });

  const host = createHost({ name: "planet-example" });
  host.install(audioAdapter);
  host.install(localSource);
  const playerHandle = host.install(playerPlugin);
  host.install(historyPlugin);
  host.install(shellPlugin);
  const providers = host.group("providers", () => undefined);
  await host.start();

  const platform = createPlatform({
    installer: providers,
    apiVersion: "1.0.0",
    permissions: new PermissionSet(["network"]),
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

  await player.play("intro");
  await platform.trigger("media:remote");
  await player.play("album 42");
  await remote.remove();
  await player.play("outro");

  const lifetime = host.diagnostics.get().installations.get(playerHandle.id)?.lifetime?.get();
  await platform.dispose();
  await providers.remove();
  await host.stop();

  return exampleResult({
    id: "09",
    stage: "hosts",
    title: "Planet: media providers, playback ownership and runtime selection",
    introduces: ["runtime-selection", "live-provider-swap", "group-scoped-platform"],
    facts: [
      `The player picked the best available source each time: ${history.map((track) => track.source).join(" → ")}.`,
      `Audio output received ${audioUris.join(", ")}.`,
      `Providers were added and removed live, yet the player started ${playerStarts} time — an ExtensionPoint is not a dependency edge.`,
      `The shell observed ${shellTracks.join(", ")}; the player kept ${lifetime?.children.length} playback Lifetime, replaced per track.`,
      "The Platform was scoped to the /providers Group, so removing that Group removed every downloaded provider with it.",
    ],
  });
}
