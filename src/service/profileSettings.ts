import type { ServiceConfig } from './config';
import { CUT_DEFAULTS, detectorDefaults } from './defaults';

export interface ProfileSettings {
  detector: {
    chat: { windowS: number; baselineS: number; alpha: number; endSpike: number; minSpike: number;
            minTriggerMessages: number; minTriggerAuthors: number; minTriggerShare: number;
            laughWords: string[]; reactionWords: string[] };
    audio: { baselineS: number; spikeDb: number; spikeVad: number; spikeMinMs: number };
    events: { warmupS: number; lookbackS: number; chatLagS: number; voiceWindowS: number; mergeGapS: number; maxEventS: number };
    score: { shareFull: number; spikeFull: number; audioMinDb: number; audioFullDb: number };
  };
  cut: { preRollMs: number; preRollLowConfidenceMs: number; postRollMs: number; maxClipMs: number; maxClipsPerHour: number };
}
export type FieldGroup = 'trigger' | 'event' | 'score' | 'audio' | 'cut' | 'windows';
/** 'now' — со следующей секунды; 'window' — по мере набора данных. */
export type AppliesWhen = 'now' | 'window';
/** How the stored number is shown: 'percent' — a 0–1 share as percent; 'seconds' — milliseconds as seconds. */
export type FieldDisplay = 'percent' | 'seconds';
export interface FieldDef {
  path: string; label: string; unit: string; hint: string; group: FieldGroup;
  min: number; max: number; integer: boolean; applies: AppliesWhen;
  /** The slider's working range and step, in stored units; the number input accepts min…max. */
  sliderMin: number; sliderMax: number; step: number;
  display?: FieldDisplay;
  /** Shown at the top of the editor, outside the collapsed groups. */
  basic: boolean;
}

interface Ui { slider: [number, number]; step: number; display?: FieldDisplay; basic?: boolean }

const f = (
  path: string, label: string, unit: string, group: FieldGroup, min: number, max: number,
  integer: boolean, applies: AppliesWhen, hint: string, ui: Ui,
): FieldDef => ({
  path, label, unit, hint, group, min, max, integer, applies,
  sliderMin: ui.slider[0], sliderMax: ui.slider[1], step: ui.step,
  ...(ui.display ? { display: ui.display } : {}), basic: ui.basic ?? false,
});

export const FIELDS: FieldDef[] = [
  f('detector.chat.minSpike', 'Всплеск: чат быстрее фона в', '×', 'trigger', 1.1, 20, false, 'now',
    'Первое условие. Во сколько раз чат должен ускориться относительно своего обычного темпа.',
    { slider: [1.1, 6], step: 0.1, basic: true }),
  f('detector.chat.minTriggerShare', 'Состав: триггерных сообщений, не меньше', '%', 'trigger', 0.01, 1, false, 'now',
    'Второе условие. Какая часть сообщений всплеска должна быть смехом или реакцией.',
    { slider: [0.1, 1], step: 0.05, display: 'percent', basic: true }),
  f('detector.chat.minTriggerMessages', 'Триггерных сообщений, не меньше', 'шт.', 'trigger', 1, 1000, true, 'now',
    'Сколько сообщений со смехом или реакцией должно прийти в окне подсчёта, чтобы сработал триггер.',
    { slider: [1, 20], step: 1, basic: true }),
  f('detector.chat.minTriggerAuthors', 'Авторов триггерных сообщений, не меньше', 'чел.', 'trigger', 1, 1000, true, 'now',
    'Сколько разных зрителей должны написать триггерные сообщения; защита от одного спамера.',
    { slider: [1, 10], step: 1, basic: true }),
  f('cut.preRollMs', 'Запас до события', 'с', 'cut', 0, 120000, false, 'now',
    'Сколько видео добавляется в клип до начала события.',
    { slider: [0, 60000], step: 1000, display: 'seconds', basic: true }),
  f('cut.postRollMs', 'Запас после события', 'с', 'cut', 0, 120000, false, 'now',
    'Сколько видео добавляется в клип после конца события.',
    { slider: [0, 60000], step: 1000, display: 'seconds', basic: true }),
  f('detector.chat.endSpike', 'Событие длится, пока скорость чата не ниже', '×', 'event', 1, 20, false, 'now',
    'Во сколько раз скорость чата должна превышать фон, чтобы событие продолжалось; не больше порога всплеска.',
    { slider: [1, 4], step: 0.1 }),
  f('detector.chat.alpha', 'Сглаживание скорости чата', '—', 'event', 0.1, 10, false, 'now',
    'Насколько сглаживается скорость чата; больше — плавнее и медленнее реакция.',
    { slider: [0.1, 5], step: 0.1 }),
  f('detector.events.mergeGapS', 'Склеивать события ближе', 'с', 'event', 0, 120, false, 'now',
    'Если следующее событие начинается раньше этого срока после предыдущего, они объединяются.',
    { slider: [0, 60], step: 1 }),
  f('detector.events.maxEventS', 'Максимум длины события', 'с', 'event', 5, 600, false, 'now',
    'Событие принудительно закрывается, если длится дольше.',
    { slider: [5, 180], step: 5 }),
  f('detector.events.lookbackS', 'Искать голос до реакции чата за', 'с', 'event', 1, 120, false, 'now',
    'Насколько далеко назад от реакции чата искать голосовой всплеск, чтобы найти начало момента.',
    { slider: [1, 60], step: 1 }),
  f('detector.events.chatLagS', 'Задержка чата, если голоса не было', 'с', 'event', 0, 60, false, 'now',
    'На сколько секунд сдвигается начало момента назад, если голосового всплеска не нашлось.',
    { slider: [0, 30], step: 1 }),
  f('detector.events.voiceWindowS', 'Учитывать звук до события за', 'с', 'event', 0, 120, false, 'now',
    'За какое время до события учитывается громкость звука при оценке.',
    { slider: [0, 60], step: 1 }),
  f('detector.score.spikeFull', 'Скорость чата, дающая 5 баллов', '×', 'score', 1.2, 100, false, 'now',
    'Во сколько раз скорость чата превышает фон, чтобы вклад всплеска в оценку был максимален; больше порога всплеска.',
    { slider: [2, 15], step: 0.5 }),
  f('detector.score.shareFull', 'Состав, дающий 3 балла', '%', 'score', 0.02, 1, false, 'now',
    'Доля триггерных сообщений, при которой вклад состава в оценку максимален; больше порога состава.',
    { slider: [0.2, 1], step: 0.05, display: 'percent' }),
  f('detector.score.audioMinDb', 'Звук начинает давать баллы с', 'дБ', 'score', 0, 60, false, 'now',
    'Превышение громкости над фоном, с которого звук начинает прибавлять баллы.',
    { slider: [0, 30], step: 1 }),
  f('detector.score.audioFullDb', 'Звук даёт 1 балл при', 'дБ', 'score', 1, 80, false, 'now',
    'Превышение громкости над фоном, при котором вклад звука максимален; должно быть больше нижней границы.',
    { slider: [5, 40], step: 1 }),
  f('detector.audio.spikeDb', 'Голосовой всплеск: громче фона на', 'дБ', 'audio', 1, 60, false, 'now',
    'Насколько звук должен быть громче фона, чтобы считаться всплеском.',
    { slider: [3, 30], step: 1 }),
  f('detector.audio.spikeVad', 'Голосовой всплеск: вероятность голоса от', '0–1', 'audio', 0, 1, false, 'now',
    'Минимальная вероятность того, что в звуке голос, а не музыка или шум.',
    { slider: [0, 1], step: 0.05 }),
  f('detector.audio.spikeMinMs', 'Голосовой всплеск: не короче', 'мс', 'audio', 100, 10000, false, 'now',
    'Минимальная длительность всплеска; более короткие игнорируются.',
    { slider: [100, 3000], step: 100 }),
  f('cut.preRollLowConfidenceMs', 'Запас до события при низкой уверенности', 'с', 'cut', 0, 120000, false, 'now',
    'Запас до события, когда голосовой всплеск не найден и начало определено неточно.',
    { slider: [0, 60000], step: 1000, display: 'seconds' }),
  f('cut.maxClipMs', 'Максимум длины клипа', 'с', 'cut', 5000, 600000, false, 'now',
    'Клип обрезается, если получается длиннее; не может быть меньше запаса после события.',
    { slider: [10000, 300000], step: 5000, display: 'seconds' }),
  f('cut.maxClipsPerHour', 'Клипов в час, не больше', 'шт.', 'cut', 1, 1000, true, 'now',
    'Сколько клипов в час можно сохранить; лишние отбрасываются.',
    { slider: [1, 60], step: 1 }),
  f('detector.chat.windowS', 'Окно подсчёта сообщений', 'с', 'windows', 1, 60, false, 'window',
    'За какое время считаются скорость чата и состав всплеска.',
    { slider: [1, 30], step: 1 }),
  f('detector.chat.baselineS', 'Фон чата', 'с', 'windows', 30, 1800, false, 'window',
    'За какое время усредняется обычная скорость чата, с которой сравнивается всплеск.',
    { slider: [30, 900], step: 30 }),
  f('detector.audio.baselineS', 'Фон звука', 'с', 'windows', 5, 600, false, 'window',
    'За какое время усредняется обычная громкость, с которой сравнивается всплеск.',
    { slider: [5, 180], step: 5 }),
  f('detector.events.warmupS', 'Прогрев после запуска', 'с', 'windows', 0, 600, false, 'now',
    'Сколько секунд после запуска детектор только копит фон и не срабатывает.',
    { slider: [0, 300], step: 5 }),
];

export const GROUP_LABELS: Record<FieldGroup, string> = {
  trigger: 'Срабатывание', event: 'Событие', score: 'Оценка', audio: 'Звук', cut: 'Нарезка', windows: 'Окна',
};

/** Stored value → the number the editor shows. */
export const toDisplay = (def: Pick<FieldDef, 'display'>, stored: number): number =>
  def.display === 'percent' ? Math.round(stored * 1e6) / 1e4 : def.display === 'seconds' ? stored / 1000 : stored;
/** The number the editor shows → stored value. */
export const fromDisplay = (def: Pick<FieldDef, 'display'>, shown: number): number =>
  def.display === 'percent' ? Math.round(shown * 1e4) / 1e6 : def.display === 'seconds' ? Math.round(shown * 1000) : shown;

/** One field's own rule; the message names the range in the units the editor shows. null: fine. */
export function checkField(def: FieldDef, v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return `«${def.label}»: нужно число`;
  if (def.integer && !Number.isInteger(v)) return `«${def.label}»: нужно целое число`;
  if (v < def.min || v > def.max) {
    return `«${def.label}»: допустимо от ${String(toDisplay(def, def.min))} до ${String(toDisplay(def, def.max))}`;
  }
  return null;
}

/** Rules that tie two fields together; `n` reads a stored value by path. null: fine. */
export function checkPairs(n: (path: string) => number): { error: string; path: string } | null {
  const bad = (error: string, path: string) => ({ error, path });
  if (n('detector.chat.endSpike') > n('detector.chat.minSpike')) {
    return bad('«Событие длится, пока скорость чата не ниже» не может быть больше порога всплеска', 'detector.chat.endSpike');
  }
  if (n('detector.score.spikeFull') <= n('detector.chat.minSpike')) {
    return bad('«Скорость чата, дающая 5 баллов» должна быть больше порога всплеска', 'detector.score.spikeFull');
  }
  if (n('detector.score.shareFull') <= n('detector.chat.minTriggerShare')) {
    return bad('«Состав, дающий 3 балла» должен быть больше порога состава', 'detector.score.shareFull');
  }
  if (n('detector.score.audioFullDb') <= n('detector.score.audioMinDb')) {
    return bad('«Звук даёт 1 балл при» должно быть больше «Звук начинает давать баллы с»', 'detector.score.audioFullDb');
  }
  if (n('cut.maxClipMs') < n('cut.postRollMs')) {
    return bad('«Максимум длины клипа» не может быть меньше «Запас после события»', 'cut.maxClipMs');
  }
  return null;
}

export const DICTIONARIES: Array<{ path: 'detector.chat.laughWords' | 'detector.chat.reactionWords'; label: string }> = [
  { path: 'detector.chat.laughWords', label: 'Смех' },
  { path: 'detector.chat.reactionWords', label: 'Реакции' },
];

export const MAX_PATTERNS = 100;
export const MAX_PATTERN_LENGTH = 100;

type Words = { laugh: string[]; reaction: string[] };

/** Single place that fixes the shape and key order of ProfileSettings. */
function assemble(num: (path: string) => number, words: Words): ProfileSettings {
  const n = num;
  return {
    detector: {
      chat: {
        windowS: n('detector.chat.windowS'), baselineS: n('detector.chat.baselineS'), alpha: n('detector.chat.alpha'),
        endSpike: n('detector.chat.endSpike'), minSpike: n('detector.chat.minSpike'),
        minTriggerMessages: n('detector.chat.minTriggerMessages'), minTriggerAuthors: n('detector.chat.minTriggerAuthors'),
        minTriggerShare: n('detector.chat.minTriggerShare'),
        laughWords: words.laugh, reactionWords: words.reaction,
      },
      audio: {
        baselineS: n('detector.audio.baselineS'), spikeDb: n('detector.audio.spikeDb'),
        spikeVad: n('detector.audio.spikeVad'), spikeMinMs: n('detector.audio.spikeMinMs'),
      },
      events: {
        warmupS: n('detector.events.warmupS'), lookbackS: n('detector.events.lookbackS'), chatLagS: n('detector.events.chatLagS'),
        voiceWindowS: n('detector.events.voiceWindowS'), mergeGapS: n('detector.events.mergeGapS'), maxEventS: n('detector.events.maxEventS'),
      },
      score: {
        shareFull: n('detector.score.shareFull'), spikeFull: n('detector.score.spikeFull'),
        audioMinDb: n('detector.score.audioMinDb'), audioFullDb: n('detector.score.audioFullDb'),
      },
    },
    cut: {
      preRollMs: n('cut.preRollMs'), preRollLowConfidenceMs: n('cut.preRollLowConfidenceMs'),
      postRollMs: n('cut.postRollMs'), maxClipMs: n('cut.maxClipMs'), maxClipsPerHour: n('cut.maxClipsPerHour'),
    },
  };
}

const at = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[k] : undefined), root);

export function settingsFromConfig(
  cfg: Pick<ServiceConfig, 'detector' | 'preRollMs' | 'preRollLowConfidenceMs' | 'postRollMs' | 'maxClipMs' | 'maxClipsPerHour'>,
): ProfileSettings {
  // `cut.*` lives at the top level of ServiceConfig; everything else under `detector`.
  const num = (path: string) => at(path.startsWith('cut.') ? { cut: cfg } : cfg, path) as number;
  return assemble(num, { laugh: [...cfg.detector.chat.laughWords], reaction: [...cfg.detector.chat.reactionWords] });
}

/** An unbounded quantifier not escaped by a backslash: *, + or {n,}; mirrors _UNBOUNDED in detector/hl_detector/config.py. */
const UNBOUNDED = /(?<!\\)(?:[*+]|\{[0-9]+,\})/g;
const MAX_UNBOUNDED = 3;

/** True for patterns that can hang the matcher: repetition after a group, a backreference,
 *  or more than three unbounded quantifiers. */
export function unsafePattern(p: string): boolean {
  return /\)[*+{]/.test(p) || /\\[1-9]/.test(p) || (p.match(UNBOUNDED)?.length ?? 0) > MAX_UNBOUNDED;
}

type Result = { ok: true; value: ProfileSettings } | { ok: false; error: string; path: string };
const fail = (error: string, path: string): Result => ({ ok: false, error, path });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateSettings(raw: unknown): Result {
  const generic = fail('Некорректные настройки профиля', '');
  if (!isObj(raw) || !isObj(raw.detector) || !isObj(raw.cut)) return generic;
  const d = raw.detector;
  if (!isObj(d.chat) || !isObj(d.audio) || !isObj(d.events) || !isObj(d.score)) return generic;

  const values = new Map<string, number>();
  for (const def of FIELDS) {
    const v = at(raw, def.path);
    const error = checkField(def, v);
    if (error) return fail(error, def.path);
    values.set(def.path, v as number);
  }

  const cleaned: string[][] = [];
  for (const dict of DICTIONARIES) {
    const label = dict.label;
    const v = at(raw, dict.path);
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return fail(`«${label}»: нужен список шаблонов`, dict.path);
    const list = [...new Set((v as string[]).map((s) => s.trim()).filter((s) => s !== ''))];
    if (list.length > MAX_PATTERNS) return fail(`«${label}»: не больше ${MAX_PATTERNS} шаблонов`, dict.path);
    for (const p of list) {
      if (p.length > MAX_PATTERN_LENGTH) return fail(`«${label}»: шаблон длиннее ${MAX_PATTERN_LENGTH} символов: ${p}`, dict.path);
      try { new RegExp(p, 'i'); } catch { return fail(`«${label}»: неверный шаблон: ${p}`, dict.path); }
      if (unsafePattern(p)) {
        return fail(`«${label}»: шаблон может подвесить детектор (повторение после скобок или обратная ссылка): ${p}`, dict.path);
      }
    }
    cleaned.push(list);
  }

  const n = (path: string) => values.get(path) as number;
  const pair = checkPairs(n);
  if (pair) return fail(pair.error, pair.path);
  return { ok: true, value: assemble(n, { laugh: cleaned[0], reaction: cleaned[1] }) };
}

/** The values the service ships with (not the editable «По умолчанию» profile). */
export function factorySettings(): ProfileSettings {
  return settingsFromConfig({ ...CUT_DEFAULTS, detector: detectorDefaults() });
}

/**
 * Settings of any age or shape → the current shape. Settings without `detector.chat.minSpike` predate the
 * spike-then-composition rule: their share thresholds measured another quantity and are reset, the speed pair
 * is fitted around the new threshold. Missing or non-numeric values come from the factory settings; unknown
 * keys are dropped. Idempotent.
 */
export function migrateSettings(raw: unknown): ProfileSettings {
  const factory = factorySettings();
  const num = (path: string): number => {
    const v = at(raw, path);
    return typeof v === 'number' && Number.isFinite(v) ? v : (at(factory, path) as number);
  };
  const words = (path: string): string[] => {
    const v = at(raw, path);
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...(v as string[])] : [...(at(factory, path) as string[])];
  };
  const out = assemble(num, { laugh: words('detector.chat.laughWords'), reaction: words('detector.chat.reactionWords') });
  if (typeof at(raw, 'detector.chat.minSpike') !== 'number') {
    const chat = out.detector.chat;
    chat.minSpike = factory.detector.chat.minSpike;
    chat.minTriggerShare = factory.detector.chat.minTriggerShare;
    out.detector.score.shareFull = factory.detector.score.shareFull;
    out.detector.score.spikeFull = Math.max(out.detector.score.spikeFull, chat.minSpike + 1);
    chat.endSpike = Math.min(chat.endSpike, chat.minSpike);
  }
  return out;
}
