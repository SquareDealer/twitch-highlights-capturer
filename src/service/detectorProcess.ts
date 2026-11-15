import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { DetectorEvent } from './types';

export interface DetectorSignals {
  tMs: number;
  chatSpike: number;
  laughShare: number;
  messages: number;
  deltaDb: number;
  vad: number;
  warm: boolean;
}

export interface DetectorHealth {
  running: boolean;
  chat: 'connected' | 'disconnected' | 'unknown';
  restarts: number;
}

export interface DetectorProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  heartbeatTimeoutMs?: number;
  restartDelaysMs?: number[];
  stopTimeoutMs?: number;
  spawn?: typeof nodeSpawn;
}

const FRAME_PCM = 0;
const FRAME_JSON = 1;
const MAX_PCM_FRAME = 64 * 1024;
const STDERR_LINES = 20;
const PCM_BYTES_PER_MS = 32; // s16le mono 16 kHz

function frame(kind: number, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(kind, 0);
  head.writeUInt32LE(body.length, 1);
  return Buffer.concat([head, body]);
}

function jsonFrame(obj: object): Buffer {
  return frame(FRAME_JSON, Buffer.from(JSON.stringify(obj), 'utf8'));
}

/**
 * Supervises the Python detector. The PCM stream attached via attachPcm is
 * ffmpeg's stdout: it is ALWAYS consumed, and chunks are dropped whenever the
 * detector is down or its stdin is backpressured, so recording never stalls.
 *
 * The detector's clock must stay on the epoch's stream time: every byte of the
 * epoch's PCM is counted (forwarded or dropped), a (re-)announced epoch frame
 * carries the stream time the detector starts at, and after a drop a resync
 * frame moves the detector's clock over the gap before the next forwarded chunk.
 */
export class DetectorProcess extends EventEmitter {
  private readonly heartbeatTimeoutMs: number;
  private readonly restartDelaysMs: number[];
  private readonly stopTimeoutMs: number;
  private readonly spawnFn: typeof nodeSpawn;

  private child: ChildProcess | null = null;
  private running = false;
  private blocked = false;
  private stopped = false;
  private started = false;
  private chat: DetectorHealth['chat'] = 'unknown';
  private restarts = 0;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private epoch: number | null = null;
  private epochBytes = 0; // PCM bytes of the current epoch received from the pcm stream
  private gap = false; // PCM was dropped since the detector's clock was last set
  private realign = false; // the next forwarded byte must start an s16 sample
  private pcm: Readable | null = null;
  private pcmListener: ((chunk: Buffer) => void) | null = null;
  private readonly pcmErrorListener = () => undefined;
  private stderrTail: string[] = [];

  constructor(private readonly opts: DetectorProcessOptions) {
    super();
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 15000;
    this.restartDelaysMs = opts.restartDelaysMs?.length ? opts.restartDelaysMs : [1000, 2000, 5000, 10000, 30000];
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 3000;
    this.spawnFn = opts.spawn ?? nodeSpawn;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.launch();
  }

  health(): DetectorHealth {
    return { running: this.running, chat: this.chat, restarts: this.restarts };
  }

  lastStderr(): string[] {
    return [...this.stderrTail];
  }

  attachPcm(pcm: Readable, epoch: number): void {
    this.detachPcm();
    this.epoch = epoch;
    this.epochBytes = 0;
    this.gap = false;
    this.realign = false;
    this.announceEpoch();
    const listener = (chunk: Buffer) => this.onPcm(chunk);
    this.pcm = pcm;
    this.pcmListener = listener;
    pcm.on('data', listener); // attaching a data listener keeps the stream flowing
    pcm.on('error', this.pcmErrorListener);
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.detachPcm();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.clearHeartbeat();
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, this.stopTimeoutMs);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.writeRaw(jsonFrame({ type: 'stop' }));
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
    });
  }

  private detachPcm(): void {
    if (this.pcm && this.pcmListener) {
      this.pcm.off('data', this.pcmListener);
      this.pcm.off('error', this.pcmErrorListener);
      this.pcm.on('error', this.pcmErrorListener); // keep one no-op so a late error can't crash
      this.pcm.resume(); // keep draining the old stream (ffmpeg stdout must never stall)
    }
    this.pcm = null;
    this.pcmListener = null;
  }

  private launch(): void {
    if (this.stopped) return;
    let child: ChildProcess;
    try {
      child = this.spawnFn(this.opts.command, this.opts.args, {
        cwd: this.opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.blocked = false;
    let ended = false;
    const onEnd = () => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.child = null;
      this.clearHeartbeat();
      this.setRunning(false);
      this.scheduleRestart();
    };
    child.on('error', onEnd);
    child.on('close', onEnd);
    child.stdin?.on('error', () => undefined);
    child.stdin?.on('drain', () => {
      if (this.child === child) this.blocked = false;
    });
    child.stderr?.on('data', (d: Buffer) => this.keepStderr(d));
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (this.child === child) this.onLine(line);
      });
    }
    if (child.pid === undefined) return; // spawn failure: 'error' follows
    this.setRunning(true);
    this.armHeartbeat(child);
    this.announceEpoch();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = this.restartDelaysMs[Math.min(this.failures, this.restartDelaysMs.length - 1)];
    this.failures++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped) return;
      this.restarts++;
      this.launch();
      this.emitHealth();
    }, delay);
  }

  private armHeartbeat(child: ChildProcess): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, this.heartbeatTimeoutMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (this.child) this.armHeartbeat(this.child);
    this.failures = 0;
    const { type, ...rest } = msg;
    switch (type) {
      case 'event':
        this.emit('event', rest as DetectorEvent);
        break;
      case 'signals':
        this.emit('signals', rest as DetectorSignals);
        break;
      case 'nearmiss':
        this.emit('nearmiss', rest);
        break;
      case 'status':
        if (rest.chat === 'connected' || rest.chat === 'disconnected') {
          this.chat = rest.chat;
          this.emitHealth();
        }
        break;
      default:
        break; // heartbeat and unknown types
    }
  }

  private onPcm(chunk: Buffer): void {
    const start = this.epochBytes;
    this.epochBytes += chunk.length;
    if (!this.running || this.blocked || !this.child?.stdin?.writable) {
      this.gap = true; // discard
      return;
    }
    if (this.gap) {
      this.gap = false;
      this.realign = true;
      this.writeRaw(jsonFrame({ type: 'resync', tMs: Math.floor(start / PCM_BYTES_PER_MS) }));
    }
    if (this.realign) {
      this.realign = false;
      if (start % 2 === 1) chunk = chunk.subarray(1);
    }
    for (let off = 0; off < chunk.length; off += MAX_PCM_FRAME) {
      const ok = this.writeRaw(frame(FRAME_PCM, chunk.subarray(off, off + MAX_PCM_FRAME)));
      if (!ok) this.blocked = true; // later chunks are dropped until 'drain'
    }
  }

  private announceEpoch(): void {
    if (this.epoch === null || !this.running) return;
    this.writeRaw(jsonFrame({ type: 'epoch', epoch: this.epoch, startMs: Math.floor(this.epochBytes / PCM_BYTES_PER_MS) }));
    this.gap = false;
    this.realign = true;
  }

  private writeRaw(buf: Buffer): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable) return true;
    try {
      return stdin.write(buf);
    } catch {
      return true;
    }
  }

  private keepStderr(d: Buffer): void {
    for (const l of d.toString('utf8').split(/\r?\n/)) if (l) this.stderrTail.push(l);
    if (this.stderrTail.length > STDERR_LINES) this.stderrTail.splice(0, this.stderrTail.length - STDERR_LINES);
  }

  private setRunning(v: boolean): void {
    if (this.running === v) return;
    this.running = v;
    this.emitHealth();
  }

  private emitHealth(): void {
    this.emit('health', this.health());
  }
}
