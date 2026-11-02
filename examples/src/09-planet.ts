import {
  asyncDisposeSymbol,
  createHost,
  definePlugin,
  event,
  extensionPoint,
  service,
} from "dougong";
import { createPlatform, MemoryLoader, PermissionSet } from "@dougongjs/platform";
import { computed, signal, type ReadonlySignal } from "@dougongjs/reactive";
import { exampleResult, type ExampleResult } from "./example.js";

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

export async function planetScenario(): Promise<ExampleResult> {
  const audioUris: string[] = [];
  const history: Track[] = [];
  const shellTracks: string[] = [];
  let supersededPlaybacks = 0;
  let playerStarts = 0;
  const playing = Promise.withResolvers<void>();
  const finishPlayback = Promise.withResolvers<void>();

  const audioAdapter = definePlugin({
    name: "examples.planet.adapter.audio",
    provides: { audio: AUDIO_OUTPUT },
    setup: () => ({
      audio: {
        async play(uri: string, signal: AbortSignal) {
          signal.throwIfAborted();
          audioUris.push(uri);
          if (uri.endsWith("/superseded")) {
            playing.resolve();
            await finishPlayback.promise;
          }
        },
      },
    }),
  });
  const localSource = definePlugin({
    name: "examples.planet.source.local",
    setup(context) {
      context.contributions.add(MEDIA_SOURCES, "local", {
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
    setup(context) {
      playerStarts++;
      const current = signal<Track | undefined>(undefined);
      let playback = context.lifetime.child("playback");

      return {
        player: {
          current: computed(() => current.get()),
          async play(query: string) {
            const previous = playback;
            const currentPlayback = context.lifetime.child("playback");
            playback = currentPlayback;
            await previous[asyncDisposeSymbol]();
            let selected: { id: string; score: number } | undefined;
            for (const id of context.dependencies.sources.get()) {
              const score = await context.dependencies.sources.use(id, (source) =>
                source.score(query),
              );
              if (!selected || score > selected.score) selected = { id, score };
            }
            if (!selected) throw new Error("No media source is available");
            const track = await context.dependencies.sources.use(selected.id, async (source) => {
              const uri = await source.resolve(query, currentPlayback.signal);
              currentPlayback.signal.throwIfAborted();
              await context.dependencies.audio.play(uri, currentPlayback.signal);
              return Object.freeze({ query, uri, source: source.id });
            });
            // An external output can finish after the next playback has taken ownership.
            currentPlayback.signal.throwIfAborted();
            current.set(track);
            await context.events.emit(TRACK_CHANGED, track);
          },
        },
      };
    },
  });
  const historyPlugin = definePlugin({
    name: "examples.planet.history",
    setup(context) {
      context.events.on(TRACK_CHANGED, (track) => history.push(track));
    },
  });
  const shellPlugin = definePlugin({
    name: "examples.planet.shell",
    requires: { player: PLAYER },
    setup(context) {
      const synchronize = () => {
        const track = context.dependencies.player.current.get();
        if (track) shellTracks.push(`${track.source}:${track.query}`);
      };
      context.lifetime.use(context.dependencies.player.current.subscribe(synchronize));
    },
  });
  const remoteSource = definePlugin({
    name: "examples.planet.source.remote",
    setup(context) {
      context.contributions.add(MEDIA_SOURCES, "remote", {
        id: "remote",
        score: () => 100,
        async resolve(query, signal) {
          signal.throwIfAborted();
          return `https://media.example/${encodeURIComponent(query)}`;
        },
      });
    },
  });

  const host = createHost({
    name: "planet-example",
    installations: [
      { id: "audio", plugin: audioAdapter },
      { id: "local", plugin: localSource },
      { id: "player", plugin: playerPlugin },
      { id: "history", plugin: historyPlugin },
      { id: "shell", plugin: shellPlugin },
    ],
  });
  await host.start();

  const remoteReference = "remote";
  const remoteActivation = "media:remote";
  const platform = createPlatform({
    id: "media-providers",
    host,
    apiVersion: "1.0.0",
    authorizer: new PermissionSet(["network"]),
    loader: new MemoryLoader(new Map([[remoteReference, { default: remoteSource }]])),
  });
  const remote = await platform.select(
    platform.catalog.add({
      revision: "remote-content-1",
      manifest: {
        name: remoteSource.name,
        version: "1.0.0",
        activation: [remoteActivation],
        permissions: ["network"],
      },
      reference: remoteReference,
    }),
  );

  await host.use(PLAYER, (player) => player.play("intro"));
  await platform.trigger(remoteActivation);
  const superseded = host
    .use(PLAYER, (player) => player.play("superseded"))
    .catch((error: unknown) => {
      if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
      supersededPlaybacks++;
    });
  await playing.promise;
  try {
    await host.use(PLAYER, (player) => player.play("album 42"));
  } finally {
    finishPlayback.resolve();
  }
  await superseded;
  await platform.remove(remote);
  await host.use(PLAYER, (player) => player.play("outro"));

  await platform[asyncDisposeSymbol]();
  await host.stop();

  return exampleResult({
    id: "09",
    title: "Planet: media providers, playback ownership and call-time selection",
    facts: [
      `The player picked the best available source each time: ${history.map((track) => track.source).join(" → ")}.`,
      `Audio output received ${audioUris.join(", ")}.`,
      `Providers were added and removed live, yet the player started ${playerStarts} time — an ExtensionPoint is not a dependency edge.`,
      `Replacing playback aborted ${supersededPlaybacks} late playback completion before it could publish a track.`,
      `The shell observed ${shellTracks.join(", ")}; the player kept one playback Lifetime, replaced per track.`,
      "Platform owns its installation identities; disposal removes its downloaded providers through one Core Plan.",
    ],
  });
}
