import type { ServiceConfig } from './config';

export interface ProfileSettings {
  detector: {
    chat: { windowS: number; baselineS: number; alpha: number; endSpike: number; activeWindowS: number; minActive: number;
            minTriggerMessages: number; minTriggerAuthors: number; minTriggerShare: number;
            laughWords: string[]; reactionWords: string[] };
    audio: { baselineS: number; spikeDb: number; spikeVad: number; spikeMinMs: number };
    events: { warmupS: number; lookbackS: number; chatLagS: number; voiceWindowS: number; mergeGapS: number; maxEventS: number };
    score: { shareFull: number; spikeFull: number; audioMinDb: number; audioFullDb: number };
  };
  cut: { preRollMs: number; preRollLowConfidenceMs: number; postRollMs: number; maxClipMs: number; maxClipsPerHour: number };
}
export type FieldGroup = 'trigger' | 'event' | 'score' | 'audio' | 'cut';
/** 'now' — со следующей секунды; 'window' — по мере набора данных. */
export type AppliesWhen = 'now' | 'window';
export interface FieldDef {
  path: string; label: string; unit: string; hint: string; group: FieldGroup;
  min: number; max: number; integer: boolean; applies: AppliesWhen;
}

const f = (
  path: string, label: string, unit: string, group: FieldGroup, min: number, max: number,
  integer: boolean, applies: AppliesWhen, hint: string,
): FieldDef => ({ path, label, unit, hint, group, min, max, integer, applies });

export const FIELDS: FieldDef[] = [
  f('detector.chat.minTriggerMessages', 'Триггерных сообщений, не меньше', 'шт.', 'trigger', 1, 1000, true, 'now',
    'Сколько сообщений со смехом или реакцией должно прийти в окне подсчёта, чтобы сработал триггер.'),
  f('detector.chat.minTriggerAuthors', 'Авторов триггерных сообщений, не меньше', 'чел.', 'trigger', 1, 1000, true, 'now',
    'Сколько разных зрителей должны написать триггерные сообщения, чтобы сработал триггер.'),
  f('detector.chat.minTriggerShare', 'Доля активных, не меньше', 'доля 0–1', 'trigger', 0.001, 1, false, 'now',
    'Какая доля активных зрителей должна написать триггерные сообщения; 0,05 — каждый двадцатый.'),
  f('detector.chat.minActive', 'Активных в чате, не меньше (для доли)', 'чел.', 'trigger', 1, 10000, true, 'now',
    'Минимальное число активных зрителей, от которого считается доля; в тихом чате доля считается от этого числа.'),
  f('detector.chat.activeWindowS', 'Кто считается активным: писал за последние', 'с', 'trigger', 30, 3600, false, 'window',
    'Зритель считается активным, если писал в чат за это время.'),
  f('detector.chat.windowS', 'Окно подсчёта сообщений', 'с', 'trigger', 1, 60, false, 'window',
    'За какое время считаются триггерные сообщения и скорость чата.'),
  f('detector.events.warmupS', 'Прогрев после запуска', 'с', 'trigger', 0, 600, false, 'now',
    'Сколько секунд после запуска детектор только копирует фон и не срабатывает.'),
  f('detector.chat.baselineS', 'Фон чата', 'с', 'event', 30, 1800, false, 'window',
    'За какое время усредняется обычная скорость чата, с которой сравнивается всплеск.'),
  f('detector.chat.alpha', 'Сглаживание скорости чата', '—', 'event', 0.1, 10, false, 'now',
    'Насколько сглаживается скорость чата; меньше — плавнее и медленнее реакция.'),
  f('detector.chat.endSpike', 'Событие длится, пока скорость чата не ниже', '×', 'event', 1, 20, false, 'now',
    'Во сколько раз скорость чата должна превышать фон, чтобы событие продолжалось.'),
  f('detector.events.mergeGapS', 'Склеивать события ближе', 'с', 'event', 0, 120, false, 'now',
    'Если следующее событие начинается раньше этого срока после предыдущего, они объединяются.'),
  f('detector.events.maxEventS', 'Максимум длины события', 'с', 'event', 5, 600, false, 'now',
    'Событие принудительно закрывается, если длится дольше.'),
  f('detector.events.lookbackS', 'Искать голос до реакции чата за', 'с', 'event', 1, 120, false, 'now',
    'Насколько далеко назад от реакции чата искать голосовой всплеск, чтобы найти начало момента.'),
  f('detector.events.chatLagS', 'Задержка чата, если голоса не было', 'с', 'event', 0, 60, false, 'now',
    'На сколько секунд сдвигается начало момента назад, если голосового всплеска не нашлось.'),
  f('detector.events.voiceWindowS', 'Учитывать звук до события за', 'с', 'event', 0, 120, false, 'now',
    'За какое время до события учитывается громкость звука при оценке.'),
  f('detector.score.shareFull', 'Доля, дающая 5 баллов', 'доля 0–1', 'score', 0.01, 1, false, 'now',
    'Доля активных зрителей, при которой вклад чата в оценку максимален; должна быть больше доли срабатывания.'),
  f('detector.score.spikeFull', 'Скорость чата, дающая 3 балла', '×', 'score', 1.1, 100, false, 'now',
    'Во сколько раз скорость чата превышает фон, чтобы вклад всплеска в оценку был максимален.'),
  f('detector.score.audioMinDb', 'Звук начинает давать баллы с', 'дБ', 'score', 0, 60, false, 'now',
    'Превышение громкости над фоном, с которого звук начинает прибавлять баллы.'),
  f('detector.score.audioFullDb', 'Звук даёт 1 балл при', 'дБ', 'score', 1, 80, false, 'now',
    'Превышение громкости над фоном, при котором вклад звука максимален; должно быть больше нижней границы.'),
  f('detector.audio.spikeDb', 'Голосовой всплеск: громче фона на', 'дБ', 'audio', 1, 60, false, 'now',
    'Насколько звук должен быть громче фона, чтобы считаться всплеском.'),
  f('detector.audio.spikeVad', 'Голосовой всплеск: вероятность голоса от', '0–1', 'audio', 0, 1, false, 'now',
    'Минимальная вероятность того, что в звуке голос, а не музыка или шум.'),
  f('detector.audio.spikeMinMs', 'Голосовой всплеск: не короче', 'мс', 'audio', 100, 10000, false, 'now',
    'Минимальная длительность всплеска; более короткие игнорируются.'),
  f('detector.audio.baselineS', 'Фон звука', 'с', 'audio', 5, 600, false, 'window',
    'За какое время усредняется обычная громкость, с которой сравнивается всплеск.'),
  f('cut.preRollMs', 'Запас до события', 'мс', 'cut', 0, 120000, false, 'now',
    'Сколько видео добавляется в клип до начала события.'),
  f('cut.preRollLowConfidenceMs', 'Запас до события при низкой уверенности', 'мс', 'cut', 0, 120000, false, 'now',
    'Запас до события, когда голосовой всплеск не найден и начало определено неточно.'),
  f('cut.postRollMs', 'Запас после события', 'мс', 'cut', 0, 120000, false, 'now',
    'Сколько видео добавляется в клип после конца события.'),
  f('cut.maxClipMs', 'Максимум длины клипа', 'мс', 'cut', 5000, 600000, false, 'now',
    'Клип обрезается, если получается длиннее; не может быть меньше запаса после события.'),
  f('cut.maxClipsPerHour', 'Клипов в час, не больше', 'шт.', 'cut', 1, 1000, true, 'now',
    'Сколько клипов в час можно сохранить; лишние отбрасываются.'),
];

export const GROUP_LABELS: Record<FieldGroup, string> = {
  trigger: 'Срабатывание', event: 'Событие', score: 'Оценка', audio: 'Звук', cut: 'Нарезка',
};

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
        endSpike: n('detector.chat.endSpike'), activeWindowS: n('detector.chat.activeWindowS'), minActive: n('detector.chat.minActive'),
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

export function settingsFromConfig(cfg: ServiceConfig): ProfileSettings {
  // `cut.*` lives at the top level of ServiceConfig; everything else under `detector`.
  const num = (path: string) => at(path.startsWith('cut.') ? { cut: cfg } : cfg, path) as number;
  return assemble(num, { laugh: [...cfg.detector.chat.laughWords], reaction: [...cfg.detector.chat.reactionWords] });
}

/** True for patterns that can hang the matcher: repetition after a group, or a backreference. */
export function unsafePattern(p: string): boolean {
  return /\)[*+{]/.test(p) || /\\[1-9]/.test(p);
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
    if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`«${def.label}»: нужно число`, def.path);
    if (def.integer && !Number.isInteger(v)) return fail(`«${def.label}»: нужно целое число`, def.path);
    if (v < def.min || v > def.max) {
      return fail(`«${def.label}»: допустимо от ${String(def.min)} до ${String(def.max)}`, def.path);
    }
    values.set(def.path, v);
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
  if (n('detector.score.shareFull') <= n('detector.chat.minTriggerShare')) {
    return fail('«Доля, дающая 5 баллов» должна быть больше «Доля активных, не меньше»', 'detector.score.shareFull');
  }
  if (n('detector.score.audioFullDb') <= n('detector.score.audioMinDb')) {
    return fail('«Звук даёт 1 балл при» должно быть больше «Звук начинает давать баллы с»', 'detector.score.audioFullDb');
  }
  if (n('cut.maxClipMs') < n('cut.postRollMs')) {
    return fail('«Максимум длины клипа» не может быть меньше «Запас после события»', 'cut.maxClipMs');
  }
  return { ok: true, value: assemble(n, { laugh: cleaned[0], reaction: cleaned[1] }) };
}
