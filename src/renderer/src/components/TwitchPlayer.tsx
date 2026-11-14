import { useEffect, useRef } from 'react';

interface TwitchPlayerInstance {
  setChannel(channel: string): void;
  getPlaybackStats?(): { hlsLatencyBroadcaster?: number } | undefined;
  destroy?(): void;
}
declare global {
  interface Window {
    Twitch?: { Player: new (el: HTMLElement, options: Record<string, unknown>) => TwitchPlayerInstance };
  }
}

const EMBED_SRC = 'https://player.twitch.tv/js/embed/v1.js';
let scriptPromise: Promise<void> | null = null;

function loadEmbedScript(): Promise<void> {
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = EMBED_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      script.remove();
      reject(new Error('Не удалось загрузить плеер Twitch'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

interface Props {
  channel: string;
  /** Called about once a second with the player's latency to the broadcaster, or null when unknown. */
  onLatency: (ms: number | null) => void;
  onError?: (message: string) => void;
}

/** The official Twitch Embed (video only). Recorded segments are never played back here. */
export function TwitchPlayer({ channel, onLatency, onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<TwitchPlayerInstance | null>(null);
  const latest = useRef({ channel, onLatency, onError });
  latest.current = { channel, onLatency, onError };

  useEffect(() => {
    let disposed = false;
    loadEmbedScript()
      .then(() => {
        if (disposed || !host.current || !window.Twitch) return;
        player.current = new window.Twitch.Player(host.current, {
          channel: latest.current.channel,
          parent: ['localhost'],
          width: '100%',
          height: '100%',
          autoplay: true,
          muted: false,
        });
      })
      .catch((e: Error) => latest.current.onError?.(e.message));
    const timer = setInterval(() => {
      let ms: number | null = null;
      try {
        const seconds = player.current?.getPlaybackStats?.()?.hlsLatencyBroadcaster;
        if (typeof seconds === 'number' && Number.isFinite(seconds)) ms = Math.round(seconds * 1000);
      } catch {
        ms = null;
      }
      latest.current.onLatency(ms);
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
      try {
        player.current?.destroy?.();
      } catch {
        /* the embed may already be gone */
      }
      player.current = null;
      host.current?.replaceChildren();
    };
  }, []);

  useEffect(() => {
    try {
      player.current?.setChannel(channel);
    } catch {
      /* not ready yet: the constructor picks the channel up */
    }
  }, [channel]);

  return <div className="twitch-player" ref={host} />;
}
