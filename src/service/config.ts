import fs from 'node:fs';
import path from 'node:path';

export interface DetectorConfig {
  chat: {
    windowS: number; baselineS: number; alpha: number; minMessages: number; minAuthors: number;
    laughSpike: number; laughShare: number; massSpike: number; massMinMessages: number; massMinAuthors: number;
    massReactionShare: number; repeatShare: number; endSpike: number;
    laughWords: string[]; reactionWords: string[]; interactiveWords: string[];
  };
  audio: {
    blockMs: number; baselineS: number; spikeDb: number; spikeVad: number; spikeMinMs: number;
    triggerDb: number; triggerVad: number; triggerMinMs: number;
  };
  events: { warmupS: number; lookbackS: number; chatLagS: number; voiceWindowS: number; mergeGapS: number; maxEventS: number };
  weights: { C: number; E: number; U: number; A: number };
}

export interface ServiceConfig {
  port: number;
  password: string;
  dataDir: string;
  libraryDir: string;
  bufferDir: string;
  streamlinkPath: string;
  ffmpegPath: string;
  pythonPath: string;
  multiStream: boolean;
  maxStreams: number;
  bufferSeconds: number;
  segmentSeconds: number;
  preRollMs: number;
  preRollLowConfidenceMs: number;
  postRollMs: number;
  maxClipMs: number;
  manualClipMs: number;
  maxClipsPerHour: number;
  diskReserveBytes: number;
  rejectedTtlHours: number;
  offlineEndMs: number;
  detector: DetectorConfig;
}

export function defaultConfig(dataDir: string): ServiceConfig {
  return {
    port: 8080,
    password: '',
    dataDir,
    libraryDir: path.join(dataDir, 'library'),
    bufferDir: path.join(dataDir, 'buffer'),
    streamlinkPath: 'streamlink',
    ffmpegPath: 'ffmpeg',
    pythonPath: 'python',
    multiStream: false,
    maxStreams: 5,
    bufferSeconds: 300,
    segmentSeconds: 2,
    preRollMs: 15000,
    preRollLowConfidenceMs: 30000,
    postRollMs: 10000,
    maxClipMs: 90000,
    manualClipMs: 60000,
    maxClipsPerHour: 20,
    diskReserveBytes: 10 * 1024 ** 3,
    rejectedTtlHours: 24,
    offlineEndMs: 300000,
    detector: {
      chat: {
        windowS: 5, baselineS: 300, alpha: 1, minMessages: 8, minAuthors: 5,
        laughSpike: 3, laughShare: 0.3, massSpike: 6, massMinMessages: 15, massMinAuthors: 10,
        massReactionShare: 0.2, repeatShare: 0.6, endSpike: 1.5,
        laughWords: [
          '^(а*х+а+х*)+[ах]*$', '^(a*h+a+h*)+[ah]*$', '^ору+$', '^ржу+$', '^ло+л$', '^ке+к$', '^пхп+$', '^хд+$',
          '^lo+l$', '^lmao+$', '^xd+$', '^kekw$', '^lul$', '^omegalul$', '^icant$', '😂', '🤣',
        ],
        reactionWords: [
          '^не+т+$', '^что+$', '^wtf+$', '^f$', '^pog(gers|champ)?$', '^о+мг$', '^omg+$', '^жесть$', '^капец$', '^rip$',
        ],
        interactiveWords: ['^\\d+$', '^[+\\-]+$', '^да+$', '^нет$', '^[a-dа-г]$', '^yes$', '^no$'],
      },
      audio: {
        blockMs: 100, baselineS: 45, spikeDb: 10, spikeVad: 0.5, spikeMinMs: 300,
        triggerDb: 15, triggerVad: 0.7, triggerMinMs: 500,
      },
      events: { warmupS: 60, lookbackS: 20, chatLagS: 8, voiceWindowS: 20, mergeGapS: 10, maxEventS: 60 },
      weights: { C: 0.35, E: 0.25, U: 0.2, A: 0.2 },
    },
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function merge(def: Obj, over: Obj, prefix: string): Obj {
  const out: Obj = {};
  for (const key of Object.keys(def)) {
    const d = def[key];
    const name = prefix + key;
    if (!(key in over) || over[key] === undefined) { out[key] = d; continue; }
    const v = over[key];
    if (isObj(d)) {
      if (!isObj(v)) throw new Error(`Неверный тип поля ${name}: ожидается объект`);
      out[key] = merge(d, v, name + '.');
    } else if (Array.isArray(d)) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new Error(`Неверный тип поля ${name}: ожидается массив строк`);
      }
      out[key] = v;
    } else {
      if (typeof v !== typeof d || (typeof v === 'number' && !Number.isFinite(v))) {
        throw new Error(`Неверный тип поля ${name}: ожидается ${typeof d}`);
      }
      out[key] = v;
    }
  }
  return out;
}

export function loadConfig(file: string, dataDir: string): ServiceConfig {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObj(raw)) throw new Error('Неверный формат файла конфигурации');
  // dataDir may be overridden by the file; library/buffer derive from the final dataDir unless set explicitly.
  const finalDataDir = typeof raw.dataDir === 'string' && raw.dataDir ? raw.dataDir : dataDir;
  const cfg = merge(defaultConfig(finalDataDir) as unknown as Obj, raw, '') as unknown as ServiceConfig;
  if (!cfg.password) throw new Error('Не задано поле password: пароль обязателен');
  for (const field of ['laughWords', 'reactionWords', 'interactiveWords'] as const) {
    for (const w of cfg.detector.chat[field]) {
      try { new RegExp(w, 'i'); } catch { throw new Error(`Неверное регулярное выражение в поле detector.chat.${field}: ${w}`); }
    }
  }
  return cfg;
}

export function saveConfigPatch(file: string, patch: Partial<Pick<ServiceConfig, 'multiStream'>>): void {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = isObj(raw) ? raw : {};
  fs.writeFileSync(file, JSON.stringify({ ...base, ...patch }, null, 2) + '\n', 'utf8');
}
