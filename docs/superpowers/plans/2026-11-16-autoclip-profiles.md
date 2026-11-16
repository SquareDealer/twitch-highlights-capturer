# Профили автоклипа и режим настройки — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Именованные профили порогов автоклипа, которые правятся в веб-интерфейсе и действуют на идущие эфиры сразу, плюс режим настройки с подробными значениями детектора вживую.

**Architecture:** Профили лежат в `service.sqlite`; `ProfileService` проверяет и хранит их и сообщает об изменениях. `StreamRegistry` держит профиль каждого эфира и шлёт его детекторную часть в Python управляющим кадром `config`; детектор меняет значения без сброса состояния и раз в секунду отдаёт объект `detail`. `Cutter` берёт параметры нарезки из профиля эфира и сообщает о каждом решении; сервис держит по эфиру историю кадров и журнал решений для панели настройки.

**Tech Stack:** TypeScript/Node (сервис, better-sqlite3, Vitest), Python 3.10 (детектор, pytest), React 19 (веб, Testing Library).

**Spec:** `docs/superpowers/specs/2026-11-16-autoclip-profiles-design.md`

## Global Constraints

- Правка профиля никогда не перезапускает детектор и не сбрасывает его состояние: фон чата, фон звука, прогрев, активные авторы, недавние голосовые всплески, открытое событие сохраняются.
- Правило срабатывания и формула оценки не меняются.
- Значения проверяет сервер; детектор — второй рубеж: неверный кадр `config` игнорируется, работа продолжается на прежних значениях.
- Профиль «По умолчанию» (`is_default = 1`) создаётся один раз из `config.json`; его нельзя удалить.
- В профиль **не** входят: `audio.blockMs`, `audio.triggerDb`, `audio.triggerVad`, `audio.triggerMinMs`, `chat.repeatShare`, `chat.interactiveWords`, `manualClipMs` и все общие ключи (пути, порт, пароль, буфер, лимит эфиров, резерв диска, сроки). `ServiceConfig`, `loadConfig` и `config.example.json` не меняются: эти ключи остаются первичным источником для «По умолчанию».
- Предел тела запроса 64 КБ не меняется.
- Все тексты интерфейса и ошибок — на русском; десятичный разделитель в интерфейсе — запятая (`num()` из `src/web/format.ts`).
- Приложение Electron (`src/main` кроме `db/index.ts`, `src/renderer`, `src/preload`) не трогать.
- Команды тестов: сервис и веб — `npx vitest run <файл>` из корня репозитория; детектор — `.venv/Scripts/python.exe -m pytest <файл> -v` из папки `detector`. Перед началом: 401 тест Vitest и 79 тестов pytest проходят.
- Коммит после каждой задачи; сообщения `feat: …`/`fix: …`/`docs: …`, в конце `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

1. **Число с запятой или пустое поле в редакторе** («0,05», «») → запятая принимается как точка; пустое или нечисловое поле даёт ошибку у этого поля, запрос не уходит. Тест: Task 9.
2. **Словарь из текстового поля** (пустые строки, пробелы по краям, `\r\n`, повторы) → строки обрезаются, пустые и повторные отбрасываются, ошибок нет. Тест: Task 1.
3. **`config.json` со значением, не проходящим новую проверку** (например `shareFull` ≤ `minTriggerShare`) → сервис стартует, «По умолчанию» создан как есть; ошибка появляется только при сохранении в редакторе. Тест: Task 2.
4. **Детектор упал после того, как профиль меняли на ходу** → после перезапуска получает последний набор, а не тот, с которым стартовал эфир, и до кадра `epoch`. Тест: Task 5.
5. **Смена `windowS` в первые секунды эфира** (фон пуст или короче окна) → без исключений, скорость чата конечна и ≥ 0. Тест: Task 3.

## File Structure

| Файл | Ответственность |
| --- | --- |
| `src/service/profileSettings.ts` (новый) | Типы `ProfileSettings`, таблица полей `FIELDS`, `settingsFromConfig`, `validateSettings`, `unsafePattern`. Чистый модуль без импортов Node — его импортирует и веб. |
| `src/service/profiles.ts` (новый) | `Profile`, `ProfileService`: хранение в SQLite, привязка каналов, события. |
| `src/service/tuningLog.ts` (новый) | `TuningEntry`, `TuningLog`: кольцевые буферы кадров (300) и записей журнала (100). |
| `src/main/db/index.ts` | Миграция: `profiles`, `channel_profiles`, столбцы `feed_clips`. |
| `src/service/{types,clipRepo,cutter,detectorProcess,streams,http,main}.ts` | Изменения по задачам ниже. |
| `detector/hl_detector/{config,chat,audio,events,__main__}.py` | Приём `config`, `reconfigure`, `detail`. |
| `src/web/tuning.ts` (новый) | Чистые функции панели: строки условий, текст записи журнала, разбор чисел. |
| `src/web/components/{ProfileEditor,TuningPanel,Sparkline}.tsx`, `src/web/views/Profiles.tsx` (новые) | Интерфейс. |
| `src/web/{api.ts,App.tsx,styles.css}`, `src/web/views/Streams.tsx`, `src/web/components/{StreamCard,ClipCard}.tsx` | Изменения по задачам ниже. |

---

### Task 1: Настройки профиля — типы, таблица полей, проверка

**Files:**
- Create: `src/service/profileSettings.ts`
- Test: `tests/service/profileSettings.test.ts`

**Interfaces — Produces:**

```ts
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
export type AppliesWhen = 'now' | 'window';   // 'now' — со следующей секунды; 'window' — по мере набора данных
export interface FieldDef { path: string; label: string; unit: string; hint: string; group: FieldGroup;
                            min: number; max: number; integer: boolean; applies: AppliesWhen }
export const FIELDS: FieldDef[];               // все числовые поля, path вида 'detector.chat.windowS'
export const GROUP_LABELS: Record<FieldGroup, string>;  // 'Срабатывание' | 'Событие' | 'Оценка' | 'Звук' | 'Нарезка'
export const DICTIONARIES: Array<{ path: 'detector.chat.laughWords' | 'detector.chat.reactionWords'; label: string }>;  // 'Смех', 'Реакции'
export const MAX_PATTERNS = 100;
export const MAX_PATTERN_LENGTH = 100;
export function settingsFromConfig(cfg: ServiceConfig): ProfileSettings;       // копирует только перечисленные ключи
export function unsafePattern(p: string): boolean;                             // true: /\)[*+{]/ или /\\[1-9]/
export function validateSettings(raw: unknown): { ok: true; value: ProfileSettings } | { ok: false; error: string; path: string };
```

Таблица `FIELDS` (label — название в редакторе; границы включительно):

| path | label | unit | min | max | int | group | applies |
| --- | --- | --- | --- | --- | --- | --- | --- |
| detector.chat.minTriggerMessages | Триггерных сообщений, не меньше | шт. | 1 | 1000 | да | trigger | now |
| detector.chat.minTriggerAuthors | Авторов триггерных сообщений, не меньше | чел. | 1 | 1000 | да | trigger | now |
| detector.chat.minTriggerShare | Доля активных, не меньше | доля 0–1 | 0.001 | 1 | нет | trigger | now |
| detector.chat.minActive | Активных в чате, не меньше (для доли) | чел. | 1 | 10000 | да | trigger | now |
| detector.chat.activeWindowS | Кто считается активным: писал за последние | с | 30 | 3600 | нет | trigger | window |
| detector.chat.windowS | Окно подсчёта сообщений | с | 1 | 60 | нет | trigger | window |
| detector.events.warmupS | Прогрев после запуска | с | 0 | 600 | нет | trigger | now |
| detector.chat.baselineS | Фон чата | с | 30 | 1800 | нет | event | window |
| detector.chat.alpha | Сглаживание скорости чата | — | 0.1 | 10 | нет | event | now |
| detector.chat.endSpike | Событие длится, пока скорость чата не ниже | × | 1 | 20 | нет | event | now |
| detector.events.mergeGapS | Склеивать события ближе | с | 0 | 120 | нет | event | now |
| detector.events.maxEventS | Максимум длины события | с | 5 | 600 | нет | event | now |
| detector.events.lookbackS | Искать голос до реакции чата за | с | 1 | 120 | нет | event | now |
| detector.events.chatLagS | Задержка чата, если голоса не было | с | 0 | 60 | нет | event | now |
| detector.events.voiceWindowS | Учитывать звук до события за | с | 0 | 120 | нет | event | now |
| detector.score.shareFull | Доля, дающая 5 баллов | доля 0–1 | 0.01 | 1 | нет | score | now |
| detector.score.spikeFull | Скорость чата, дающая 3 балла | × | 1.1 | 100 | нет | score | now |
| detector.score.audioMinDb | Звук начинает давать баллы с | дБ | 0 | 60 | нет | score | now |
| detector.score.audioFullDb | Звук даёт 1 балл при | дБ | 1 | 80 | нет | score | now |
| detector.audio.spikeDb | Голосовой всплеск: громче фона на | дБ | 1 | 60 | нет | audio | now |
| detector.audio.spikeVad | Голосовой всплеск: вероятность голоса от | 0–1 | 0 | 1 | нет | audio | now |
| detector.audio.spikeMinMs | Голосовой всплеск: не короче | мс | 100 | 10000 | нет | audio | now |
| detector.audio.baselineS | Фон звука | с | 5 | 600 | нет | audio | window |
| cut.preRollMs | Запас до события | мс | 0 | 120000 | нет | cut | now |
| cut.preRollLowConfidenceMs | Запас до события при низкой уверенности | мс | 0 | 120000 | нет | cut | now |
| cut.postRollMs | Запас после события | мс | 0 | 120000 | нет | cut | now |
| cut.maxClipMs | Максимум длины клипа | мс | 5000 | 600000 | нет | cut | now |
| cut.maxClipsPerHour | Клипов в час, не больше | шт. | 1 | 1000 | да | cut | now |

`hint` — одна строка на поле, что оно делает (текст пишет исполнитель задачи).

Правила `validateSettings` и точные тексты ошибок (`{label}` — из таблицы; `path` в ответе — путь поля):

- не объект / нет раздела → `'Некорректные настройки профиля'`, path `''`;
- не конечное число → `` `«${label}»: нужно число` ``; не целое при `integer` → `` `«${label}»: нужно целое число` ``; вне границ → `` `«${label}»: допустимо от ${min} до ${max}` `` (числа через `String`);
- `shareFull <= minTriggerShare` → `'«Доля, дающая 5 баллов» должна быть больше «Доля активных, не меньше»'`, path `detector.score.shareFull`;
- `audioFullDb <= audioMinDb` → `'«Звук даёт 1 балл при» должно быть больше «Звук начинает давать баллы с»'`, path `detector.score.audioFullDb`;
- `maxClipMs < postRollMs` → `'«Максимум длины клипа» не может быть меньше «Запас после события»'`, path `cut.maxClipMs`;
- словарь не массив строк → `` `«${label}»: нужен список шаблонов` ``; каждая строка обрезается по краям (`trim`, включая `\r`), пустые и повторные отбрасываются; больше `MAX_PATTERNS` → `` `«${label}»: не больше 100 шаблонов` ``; длиннее 100 → `` `«${label}»: шаблон длиннее 100 символов: ${p}` ``; `new RegExp(p, 'i')` бросает → `` `«${label}»: неверный шаблон: ${p}` ``; `unsafePattern(p)` → `` `«${label}»: шаблон может подвесить детектор (повторение после скобок или обратная ссылка): ${p}` ``;
- лишние ключи отбрасываются; `value` содержит ровно ключи `ProfileSettings`, словари — уже очищенные.

- [ ] **Step 1: Write the failing tests** in `tests/service/profileSettings.test.ts`:

```ts
import { defaultConfig } from '../../src/service/config';
import { FIELDS, settingsFromConfig, unsafePattern, validateSettings } from '../../src/service/profileSettings';

const base = () => settingsFromConfig(defaultConfig('/d'));
const set = (path: string, v: unknown) => { const s: any = base(); const k = path.split('.'); k.slice(0, -1).reduce((o, p) => o[p], s)[k.at(-1)!] = v; return s; };

it('copies exactly the profile keys from the service config', () => {
  const s = base();
  expect(s.cut).toEqual({ preRollMs: 15000, preRollLowConfidenceMs: 30000, postRollMs: 10000, maxClipMs: 90000, maxClipsPerHour: 20 });
  expect(Object.keys(s.detector.chat).sort()).toEqual(['activeWindowS', 'alpha', 'baselineS', 'endSpike', 'laughWords', 'minActive', 'minTriggerAuthors', 'minTriggerMessages', 'minTriggerShare', 'reactionWords', 'windowS']);
  expect(Object.keys(s.detector.audio).sort()).toEqual(['baselineS', 'spikeDb', 'spikeMinMs', 'spikeVad']);
});
it('accepts the defaults unchanged', () => expect(validateSettings(base())).toEqual({ ok: true, value: base() }));
it('has one FIELDS row per numeric setting', () => expect(FIELDS).toHaveLength(28));
it.each(FIELDS.map((f) => [f.path, f] as const))('rejects %s below min, above max and non-numbers', (path, f) => {
  for (const bad of [f.min - 1, f.max + 1, NaN, '5', null]) {
    const r = validateSettings(set(path, bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.path).toBe(path);
  }
});
it('requires integers for counters', () => {
  expect(validateSettings(set('detector.chat.minTriggerMessages', 2.5))).toMatchObject({ ok: false, error: '«Триггерных сообщений, не меньше»: нужно целое число' });
});
it('names the range in the error', () => {
  expect(validateSettings(set('detector.chat.windowS', 0))).toMatchObject({ ok: false, error: '«Окно подсчёта сообщений»: допустимо от 1 до 60' });
});
it('rejects the pairs the score formula divides by', () => {
  expect(validateSettings(set('detector.score.shareFull', 0.05))).toMatchObject({ ok: false, path: 'detector.score.shareFull' });
  expect(validateSettings(set('detector.score.audioFullDb', 10))).toMatchObject({ ok: false, path: 'detector.score.audioFullDb' });
  expect(validateSettings(set('cut.maxClipMs', 9000))).toMatchObject({ ok: false, path: 'cut.maxClipMs' });
});
it('cleans dictionaries: trims, drops empty lines and duplicates', () => {
  const r = validateSettings(set('detector.chat.laughWords', ['  ^lol$ ', '', '^lol$', '^kek$\r']));
  expect(r.ok && r.value.detector.chat.laughWords).toEqual(['^lol$', '^kek$']);
});
it('rejects invalid, too long, too many and hanging patterns', () => {
  const err = (v: unknown) => { const r = validateSettings(set('detector.chat.reactionWords', v)); return r.ok ? '' : r.error; };
  expect(err(['(('])).toBe('«Реакции»: неверный шаблон: ((');
  expect(err(['a'.repeat(101)])).toContain('длиннее 100 символов');
  expect(err(Array.from({ length: 101 }, (_, i) => `w${i}`))).toBe('«Реакции»: не больше 100 шаблонов');
  expect(err(['^([ах]+)+$'])).toContain('может подвесить детектор');
  expect(err('x')).toBe('«Реакции»: нужен список шаблонов');
});
it('flags repetition after a group and backreferences, allows optional groups', () => {
  expect(['^(a+)+$', '(ab)*', '(a){2,}', '(.)\\1'].map(unsafePattern)).toEqual([true, true, true, true]);
  expect(['^pog(gers|champ)?$', '^[ах]*ха[ах]*$', '^\\d+$'].map(unsafePattern)).toEqual([false, false, false]);
});
it('drops unknown keys and rejects non-objects', () => {
  const r = validateSettings({ ...base(), extra: 1, detector: { ...base().detector, weights: {} } });
  expect(r.ok && JSON.stringify(r.value)).toBe(JSON.stringify(base()));
  expect(validateSettings(null)).toEqual({ ok: false, error: 'Некорректные настройки профиля', path: '' });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/service/profileSettings.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement `src/service/profileSettings.ts`** per the Interfaces block. `import type { ServiceConfig }` only (no runtime Node imports). Numeric checks are driven by `FIELDS`; cross-field checks run after all single-field checks.
- [ ] **Step 4: Run** the same command — Expected: PASS. Run `npm run typecheck` — Expected: no errors.
- [ ] **Step 5: Commit** `feat: profile settings schema and validation`.

---

### Task 2: Хранение профилей и `ProfileService`

**Files:**
- Modify: `src/main/db/index.ts` (новая запись в `MIGRATIONS`), `src/service/types.ts` (`FeedClip`), `src/service/clipRepo.ts` (`toClip`, `insert`)
- Create: `src/service/profiles.ts`
- Test: `tests/service/profiles.test.ts`, `tests/service/clipRepo.test.ts`; поправить фабрики `FeedClip` в `tests/service/{http,janitor,cutter,streams,main}.test.ts` и `tests/web/ClipCard.test.tsx` (добавить два поля)

**Interfaces:**
- Consumes: `ProfileSettings`, `validateSettings` (Task 1).
- Produces:

```sql
CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX profiles_name ON profiles (name COLLATE NOCASE);
CREATE TABLE channel_profiles (channel TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE);
ALTER TABLE feed_clips ADD COLUMN profile_id TEXT;
ALTER TABLE feed_clips ADD COLUMN profile_name TEXT;
```

```ts
// src/service/types.ts — FeedClip gains:
profileId: string | null;     // null: ручной клип или клип до профилей
profileName: string | null;

// src/service/profiles.ts
export interface Profile { id: string; name: string; isDefault: boolean; settings: ProfileSettings; createdAt: string; updatedAt: string }
export type ProfileResult<T> = { ok: true; value: T } | { ok: false; error: string; status: 400 | 404 | 409; path?: string };
export const DEFAULT_PROFILE_NAME = 'По умолчанию';
export class ProfileService extends EventEmitter {
  /** seed() is called once, only when the table is empty; its result is stored without validation. */
  constructor(db: Db, seed: () => ProfileSettings, opts?: { now?: () => Date; newId?: () => string });
  list(): Profile[];                                   // «По умолчанию» первым, остальные по имени
  get(id: string): Profile | null;
  defaultProfile(): Profile;
  create(name: unknown, copyFrom?: unknown): ProfileResult<Profile>;
  update(id: string, patch: { name?: unknown; settings?: unknown }): ProfileResult<Profile>;
  remove(id: string): ProfileResult<null>;
  forChannel(channel: string): Profile;                // запомненный, иначе «По умолчанию»
  remember(channel: string, profileId: string): void;
}
// events: 'updated' (Profile) after update(); 'list' (Profile[]) after create/update/remove
```

Тексты ошибок: имя не строка, пустое после `trim` или длиннее 60 → 400 `'Название профиля: от 1 до 60 символов'`; имя занято (без учёта регистра) → 409 `'Профиль с таким названием уже есть'`; нет профиля (`get`, `copyFrom`) → 404 `'Профиль не найден'`; `remove` для «По умолчанию» → 409 `'Профиль «По умолчанию» нельзя удалить'`; неверные настройки → 400 с `error` и `path` из `validateSettings`; пустой `patch` → 400 `'Некорректный запрос'`. При создании «По умолчанию» в консоль один раз: `'Создан профиль «По умолчанию» из config.json. Дальше пороги и параметры нарезки правятся в веб-интерфейсе (вкладка «Профили»); эти ключи в config.json больше не читаются.'`

- [ ] **Step 1: Write the failing tests.** `tests/service/profiles.test.ts` (db — `openDb(':memory:')`, seed — `settingsFromConfig(defaultConfig('/d'))`, `newId` — счётчик `p1`, `p2`…):

```ts
it('seeds the default profile once', () => {
  const seed = vi.fn(() => SEED);
  const a = new ProfileService(db, seed);
  expect(a.list()).toMatchObject([{ name: 'По умолчанию', isDefault: true, settings: SEED }]);
  new ProfileService(db, seed);
  expect(seed).toHaveBeenCalledTimes(1);
});
it('seeds values that fail validation as they are; saving them is refused', () => {     // Review Focus 3
  const bad = structuredClone(SEED); bad.detector.score.shareFull = 0.01;
  const s = new ProfileService(db, () => bad);
  expect(s.defaultProfile().settings.detector.score.shareFull).toBe(0.01);
  expect(s.update(s.defaultProfile().id, { settings: bad })).toMatchObject({ ok: false, status: 400, path: 'detector.score.shareFull' });
});
it('creates a copy of the default or of the given profile', …);   // copyFrom → settings equal to the source's; unknown copyFrom → 404
it('rejects bad and duplicate names', …);                            // '', '  ', 61 chars → 400; 'по УМОЛЧАНИЮ' → 409
it('updates name and settings, bumps updatedAt, emits updated and list', …);
it('does not change anything when the settings are invalid', …);     // get(id) deep-equals the value before; no events
it('renaming to the same name in another case is allowed', …);
it('refuses to delete the default profile', …);                      // 409
it('remembers a profile per channel and falls back to the default', () => {
  const p = ok(s.create('Крупный канал'));
  s.remember('shroud', p.id);
  expect(s.forChannel('shroud').id).toBe(p.id);
  expect(s.forChannel('other').isDefault).toBe(true);
  s.remove(p.id);
  expect(s.forChannel('shroud').isDefault).toBe(true);              // привязка снята вместе с профилем
});
it('lists the default first, then by name', …);
```

`tests/service/clipRepo.test.ts`: `it('stores and reads the profile of a clip', …)` — вставить клип с `profileId: 'p1', profileName: 'А'` и клип с `null, null`, прочитать оба.

- [ ] **Step 2: Run** `npx vitest run tests/service/profiles.test.ts tests/service/clipRepo.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Миграция — новым элементом массива `MIGRATIONS` (существующие не менять). `ProfileService` пишет в базу синхронно; `update` сначала проверяет всё, потом одним `UPDATE`.
- [ ] **Step 4: Run** `npx vitest run` and `npm run typecheck` — Expected: всё проходит (фабрики `FeedClip` в тестах дополнены `profileId: null, profileName: null`).
- [ ] **Step 5: Commit** `feat: profile storage and service`.

---

### Task 3: Детектор — приём настроек на ходу

**Files:**
- Modify: `detector/hl_detector/config.py`, `chat.py`, `audio.py`, `events.py`, `__main__.py`
- Test: `detector/tests/test_config.py`, `test_chat.py`, `test_audio.py`, `test_events.py`, `test_main.py`

**Interfaces — Produces:**

Кадр Node → Python (тип кадра 1, JSON): `{"type":"config","version":N,"detector":{"chat":{…},"audio":{…},"events":{…},"score":{…}}}`.
Строка Python → Node: `{"type":"config","version":N,"badPatterns":[…]}`; при отказе — `{"type":"config","version":N,"badPatterns":[],"error":"<текст>"}`.

```python
# config.py
def unsafe_pattern(p: str) -> bool            # True: re.search(r"\)[*+{]|\\[1-9]", p)
def overlay(base: dict, detector) -> dict     # base с наложенным detector; ValueError, если detector не dict,
                                              # раздел не dict, число не конечное int/float (bool — не число),
                                              # список не из строк; ключи, которых нет в base, игнорируются
# chat.py
def bad_patterns(words) -> list               # шаблоны, которые не собрались или unsafe_pattern; порядок как в words
class ChatAnalyzer:
    def reconfigure(self, cfg: dict) -> None
# audio.py
class AudioAnalyzer:
    def reconfigure(self, cfg: dict) -> None  # blockMs не меняется никогда
# events.py
class EventAssembler:
    def reconfigure(self, cfg: dict) -> None
```

Требования к `reconfigure` (ни один из них не трогает накопленное состояние):

- `EventAssembler`: заменяет `self.c/self.e/self.s`; `_cur`, `epoch`, `start_ms`, `_last_nm` остаются. Открытое событие дальше закрывается и оценивается по новым значениям.
- `AudioAnalyzer`: заменяет `self.c` и `base_ms`; `block_ms`/`block_n`, `_base`, `_cur`, `_recent`, `_samples` остаются.
- `ChatAnalyzer`: заменяет `cfg`, `c`, `win_ms`, `base_ms`, `active_ms`, `warm_ms`; `_msgs`, `_marks`, `_first_tick` остаются. `_compiled` пропускает шаблоны, для которых `unsafe_pattern` истинно. Уже принятые сообщения не переклассифицируются.
- **Смена `windowS`** (только если `win_ms` изменился): `_base` пересчитывается под новое окно. Для этого анализатор хранит историю `(t_ms, user)` всех сообщений за `max(active_ms, base_ms + win_ms)` (она заменяет `_active`; число активных считается по ней же с отсечкой `active_ms`) и время, с которого история полна (`_hist_from`: время первого тика, далее — не раньше последней отсечки). Для каждой записи фона `(t, n, a)`: если `t - new_win >= _hist_from` — `n` и `a` пересчитываются по истории на отрезке `[t - new_win, t]`; иначе умножаются на `new_win / old_win`. Пустой фон остаётся пустым.

`__main__.py`: текущий конфиг хранится в изменяемом держателе (его же использует `reset_epoch` при создании нового `ChatAnalyzer`). Кадр `config`: `overlay(file_cfg, msg["detector"])` → `reconfigure` всех трёх, обновить `warm_ms`, запомнить `version`, ответить строкой с `badPatterns = bad_patterns(laughWords) + bad_patterns(reactionWords)`. `ValueError` или нецелый `version` → `log.warning`, ответ с `error`, значения прежние.

- [ ] **Step 1: Write the failing tests.**

`test_config.py`:
```python
def test_overlay_replaces_known_keys_only():
    out = overlay(DEFAULTS, {"chat": {"minTriggerShare": 0.2, "nope": 1}, "weights": {}})
    assert out["chat"]["minTriggerShare"] == 0.2 and "nope" not in out["chat"] and "weights" not in out
    assert DEFAULTS["chat"]["minTriggerShare"] == 0.05            # база не изменена
@pytest.mark.parametrize("bad", [None, [], {"chat": 5}, {"chat": {"windowS": "5"}}, {"chat": {"windowS": True}},
                                 {"chat": {"windowS": float("nan")}}, {"chat": {"laughWords": [1]}}, {"chat": {"laughWords": "x"}}])
def test_overlay_rejects_wrong_shapes(bad):
    with pytest.raises(ValueError): overlay(DEFAULTS, bad)
def test_unsafe_pattern():
    assert [unsafe_pattern(p) for p in ["^(a+)+$", "(ab)*", "(a){2,}", r"(.)\1"]] == [True] * 4
    assert [unsafe_pattern(p) for p in ["^pog(gers|champ)?$", "^[ах]*ха[ах]*$", r"^\d+$"]] == [False] * 3
```

`test_chat.py`:
```python
def cfg_with(**chat): return overlay(DEFAULTS, {"chat": chat})
def test_reconfigure_keeps_baseline_and_warmup():
    a = ChatAnalyzer(CFG); run_base(a, 6)
    base, first = list(a._base), a._first_tick
    a.reconfigure(cfg_with(minTriggerShare=0.2, endSpike=3))
    assert a._base == base and a._first_tick == first and a.tick(120_000).warm
def test_window_change_does_not_skew_spike():
    a = ChatAnalyzer(CFG); run_base(a, 6, secs=400)                # ровный чат: 6 сообщений на 5 с
    before = a.tick(400_000).spike
    a.reconfigure(cfg_with(windowS=10))
    for s in range(401, 421):
        if s % 5 == 0: feed(a, s * 1000, 6, "привет")
        last = a.tick(s * 1000 + 999)
    assert 0.8 <= last.spike <= 1.25 and 0.8 <= before <= 1.25    # без пересчёта было бы около 2
def test_window_shrink_does_not_halve_spike(): …                  # 10 с → 5 с на том же ровном чате: 0.8 <= spike <= 1.25
def test_window_change_with_empty_or_short_history():             # Review Focus 5
    a = ChatAnalyzer(CFG); a.reconfigure(cfg_with(windowS=20))    # фона нет вообще
    f = a.tick(1000); assert math.isfinite(f.spike) and f.spike >= 0
    b = ChatAnalyzer(CFG)
    for s in range(3): b.add(ChatMessage(s * 1000, f"u{s}", "x")); b.tick(s * 1000)
    b.reconfigure(cfg_with(windowS=30)); f = b.tick(3000); assert math.isfinite(f.spike) and f.spike >= 0
def test_new_dictionary_applies_to_new_messages_only():
    a = ChatAnalyzer(CFG); a.add(ChatMessage(0, "u1", "бугага"))
    a.reconfigure(cfg_with(laughWords=["^бугага$"])); a.add(ChatMessage(100, "u2", "бугага"))
    assert a.tick(1000).laugh_messages == 1
def test_active_authors_follow_active_window_after_reconfigure(): …   # 20 авторов за 300 с; activeWindowS=30 → считаются только писавшие за 30 с
def test_unsafe_pattern_is_never_run_and_is_reported():
    words = ["^([ах]+)+$", "((", "^lol$"]
    assert bad_patterns(words) == ["^([ах]+)+$", "(("]
    a = ChatAnalyzer(cfg_with(laughWords=words)); t0 = time.time()
    a.add(ChatMessage(0, "u", "ахахахахахахахахахахахахахахахахахахах!")); assert time.time() - t0 < 0.5
```

`test_audio.py`: `test_reconfigure_keeps_baseline_and_open_spike` — после 60 с ровного тона открыть всплеск, вызвать `reconfigure` с `spikeDb` 6 и `blockMs` 50: `len(a._base)` и `a._cur` прежние, `a.block_ms == 100`, следующий кадр `warm`.

`test_events.py`:
```python
def test_open_event_survives_reconfigure_and_is_scored_with_new_values():
    asm = EventAssembler(DEFAULTS)
    frames = span(70, 75, msgs=6, authors=6, active=40, spike=4.0)          # p = 0.15
    out, _, _ = run(frames, until=72, asm=asm); assert out == [] and asm._cur is not None
    asm.reconfigure(overlay(DEFAULTS, {"score": {"shareFull": 0.15}}))
    out, _, _ = run_from(73, frames, until=140, asm=asm)                    # помощник: то же, что run, но с заданной секунды
    assert len(out) == 1 and out[0][1].scores["share"] == 5.0               # по старому shareFull 0.3 было бы 2.0
def test_reconfigure_changes_the_trigger_from_the_next_tick(): …           # p = 0.04 не срабатывает; после minTriggerShare=0.03 — срабатывает
```

`test_main.py`:
```python
CONFIG = lambda v, **chat: ctl({"type": "config", "version": v, "detector": {"chat": chat}})
def test_config_frame_is_acknowledged_and_applied_without_reset():
    lines = run_chat(pcm_frames(speech(70)) + CONFIG(2, minTriggerMessages=5), LAUGHS, pcm_frames(speech(12)) + ctl({"type": "stop"}))
    assert {"type": "config", "version": 2, "badPatterns": []} in lines
    assert [l for l in lines if l["type"] == "event"] == []               # 4 сообщения < 5
    assert all(l["warm"] for l in lines if l["type"] == "signals" and l["tMs"] >= 71000)   # прогрев не сброшен
def test_config_frame_before_epoch_is_used_by_the_new_chat_analyzer(): … # config, затем epoch: порог из кадра действует в новой эпохе
def test_bad_patterns_are_returned():
    lines = run(CONFIG(3, laughWords=["^([ах]+)+$", "^lol$"]) + ctl({"type": "stop"}))
    assert {"type": "config", "version": 3, "badPatterns": ["^([ах]+)+$"]} in lines
def test_invalid_config_frame_is_refused_and_old_values_stay():
    lines = run_chat(pcm_frames(speech(70)) + ctl({"type": "config", "version": 4, "detector": {"chat": {"minTriggerMessages": "x"}}}),
                     LAUGHS, pcm_frames(speech(12)) + ctl({"type": "stop"}))
    ack = [l for l in lines if l["type"] == "config"][0]
    assert ack["version"] == 4 and ack["error"] and len([l for l in lines if l["type"] == "event"]) == 1
```

- [ ] **Step 2: Run** `.venv/Scripts/python.exe -m pytest -q` (из `detector`) — Expected: новые тесты FAIL, старые 79 проходят.
- [ ] **Step 3: Implement** per the Interfaces block. `load_config` остаётся; `overlay` — отдельная функция со строгой проверкой типов.
- [ ] **Step 4: Run** `.venv/Scripts/python.exe -m pytest -q` — Expected: все PASS.
- [ ] **Step 5: Commit** `feat(detector): live config frame without state reset`.

---

### Task 4: Детектор — подробные значения `detail`

**Files:**
- Modify: `detector/hl_detector/chat.py` (`ChatFrame`), `audio.py` (`AudioFrame`, `AudioAnalyzer`), `events.py`, `__main__.py` (`tick`)
- Test: `detector/tests/test_chat.py`, `test_audio.py`, `test_events.py`, `test_main.py`

**Interfaces:**
- Consumes: держатель текущего конфига и запомненный `version` из Task 3 (0, пока кадра `config` не было).
- Produces — в каждой строке `signals` новый ключ `detail` (существующие ключи строки не меняются):

```json
{"configVersion": 3, "sinceStartMs": 720000,
 "chat": {"messages": 14, "authors": 9, "baseline": 6.0, "spike": 2.143, "triggerMessages": 5, "triggerAuthors": 4,
          "laughMessages": 4, "reactionMessages": 1, "activeAuthors": 128, "activeAuthorsRaw": 128, "triggerShare": 0.031},
 "conditions": {"warm": true, "messages": true, "authors": true, "share": false, "fired": false},
 "audio": {"db": -31.2, "baselineDb": -38.1, "deltaDb": 7.1, "vad": 0.82, "warm": true, "spiking": false},
 "score": {"total": 1.7, "share": 0.0, "speed": 0.7, "audio": 0.0},
 "event": null}
```
`event`, когда событие открыто: `{"startMs": 81000, "durationMs": 9000, "chatOpen": true, "lowConfidence": false, "score": {"total":…, "share":…, "speed":…, "audio":…}}`.

```python
# chat.py — ChatFrame gains: baseline: float = 0.0 (медиана фона сообщений), active_authors_raw: int = 0 (без minActive)
# audio.py — AudioFrame gains: base_db: float (медиана фона; db, пока фон не прогрет);  AudioAnalyzer.spiking -> bool (property)
# events.py
class EventAssembler:
    def conditions(self, now_ms: int, frame: ChatFrame) -> dict   # ключи warm/messages/authors/share/fired; on_tick пользуется ею же
    def preview(self, frame: ChatFrame, delta_db: float) -> dict  # оценка одной текущей секунды, та же формула, что _score
    def open_state(self, now_ms: int) -> Optional[dict]           # None или словарь event из примера (без округлений сверх _score)
```
В `detail.score` звук — максимальный `delta_db` среди `audio.recent_spikes(now - voiceWindowS*1000, now)`, иначе 0. Дробные числа округляются до 3 знаков, слагаемые оценки — как в `_score`. `detail.conditions` и `detail.event` берутся **после** `on_tick` этой секунды. Пока аудиокадров не было, `detail.audio` — нули и `false`.

- [ ] **Step 1: Write the failing tests.**

```python
# test_chat.py
def test_frame_reports_baseline_and_raw_active():
    a = ChatAnalyzer(CFG); run_base(a, 6); f = a.tick(120_000)
    assert 5 <= f.baseline <= 7 and f.active_authors_raw == 6 and f.active_authors == 10
# test_audio.py
def test_frame_reports_baseline_db_and_spiking(): …   # ровный тон −40 дБ 60 с: base_db ≈ −40 (±1); во время тона −24 дБ spiking истинно, после — ложно
# test_events.py
def test_conditions_name_what_is_missing():
    asm = EventAssembler(DEFAULTS)
    assert asm.conditions(70_000, tf(70, msgs=5, authors=1, active=40)) == {"warm": True, "messages": True, "authors": False, "share": False, "fired": False}
    assert asm.conditions(10_000, tf(10))["warm"] is False
def test_preview_matches_the_spec_example():
    asm = EventAssembler(DEFAULTS)                                           # 10 % активных + чат ×4 + голос +15 дБ
    assert asm.preview(tf(70, msgs=4, authors=4, active=40, spike=4.0), 15.0) == {"total": 4.3, "share": 1.0, "speed": 1.8, "audio": 0.5}
def test_open_state_follows_the_event(): …   # None до срабатывания; во время — startMs, chatOpen True, durationMs растёт; после закрытия — None
# test_main.py
def test_signals_line_carries_detail():
    lines = run_chat(pcm_frames(speech(70)) + CONFIG(7), LAUGHS, pcm_frames(speech(3)) + ctl({"type": "stop"}))
    d = [l for l in lines if l["type"] == "signals" and l["tMs"] == 72000][0]["detail"]
    assert d["configVersion"] == 7 and d["sinceStartMs"] == 72000
    assert (d["chat"]["triggerMessages"], d["chat"]["triggerAuthors"], d["chat"]["activeAuthors"], d["chat"]["activeAuthorsRaw"]) == (4, 4, 10, 4)
    assert d["conditions"] == {"warm": True, "messages": True, "authors": True, "share": True, "fired": True}
    assert d["event"]["chatOpen"] is True and d["score"]["total"] >= 1
    assert set(d["audio"]) == {"db", "baselineDb", "deltaDb", "vad", "warm", "spiking"}
def test_detail_is_present_before_any_audio_or_config(): …   # первая строка signals: configVersion 0, event None, audio из нулей
```

- [ ] **Step 2: Run** `.venv/Scripts/python.exe -m pytest -q` — Expected: новые FAIL.
- [ ] **Step 3: Implement.** `on_tick` вызывает `conditions` (логика срабатывания не дублируется).
- [ ] **Step 4: Run** `.venv/Scripts/python.exe -m pytest -q` — Expected: все PASS.
- [ ] **Step 5: Commit** `feat(detector): per-second detail for tuning`.

---

### Task 5: `DetectorProcess` — отправка настроек и подтверждение

**Files:**
- Modify: `src/service/detectorProcess.ts`, `tests/service/fixtures/fakeDetector.mjs`
- Test: `tests/service/detectorProcess.test.ts`

**Interfaces:**
- Consumes: `ProfileSettings['detector']` (Task 1); протокол Task 3; форма `detail` Task 4.
- Produces:

```ts
export interface DetectorDetail {
  configVersion: number; sinceStartMs: number;
  chat: { messages: number; authors: number; baseline: number; spike: number; triggerMessages: number; triggerAuthors: number;
          laughMessages: number; reactionMessages: number; activeAuthors: number; activeAuthorsRaw: number; triggerShare: number };
  conditions: { warm: boolean; messages: boolean; authors: boolean; share: boolean; fired: boolean };
  audio: { db: number; baselineDb: number; deltaDb: number; vad: number; warm: boolean; spiking: boolean };
  score: { total: number; share: number; speed: number; audio: number };
  event: { startMs: number; durationMs: number; chatOpen: boolean; lowConfidence: boolean; score: DetectorDetail['score'] } | null;
}
export interface DetectorSignals { /* как сейчас */ detail?: DetectorDetail }
export interface DetectorConfigState { sent: number; applied: number; badPatterns: string[]; error?: string }  // версии; 0 — ещё не было
export class DetectorProcess {
  /** Stores the settings and sends them now if the process runs. Returns the new version (1, 2, …). */
  setConfig(detector: ProfileSettings['detector']): number;
  configState(): DetectorConfigState;
}
// new event: 'config' (DetectorConfigState) — on every acknowledgement line
```

Поведение: `launch()` шлёт сохранённый набор кадром `{type:'config', version, detector}` **перед** `announceEpoch()`; повторная отправка после перезапуска идёт с тем же номером версии. Без вызова `setConfig` кадр `config` не шлётся никогда (существующие тесты не меняются). Строка `config` от процесса с `version` меньше `sent` игнорируется.

`fakeDetector.mjs`: на кадр `{type:'config'}` печатает `{type:'config', version, badPatterns: []}`; новый флаг `--bad-pattern <p>` — возвращает `badPatterns: [p]`; новый флаг `--signals-detail` — при запуске печатает одну строку `signals` с объектом `detail` (любые значения нужной формы); кадр `config` пишется в лог как остальные управляющие.

- [ ] **Step 1: Write the failing tests:**

```ts
const D1 = settingsFromConfig(defaultConfig('/d')).detector;
it('sends the config before the epoch and reports the acknowledgement', async () => {
  const { dp, lines } = make();
  expect(dp.setConfig(D1)).toBe(1);
  const acks: unknown[] = []; dp.on('config', (s) => acks.push(s));
  dp.start(); dp.attachPcm(new PassThrough(), 7);
  await until(() => lines().length >= 2);
  expect(JSON.parse(lines()[0]!.slice(2))).toEqual({ type: 'config', version: 1, detector: D1 });
  expect(lines()[1]).toBe('1 {"type":"epoch","epoch":7,"startMs":0}');
  await until(() => dp.configState().applied === 1);
  expect(acks.at(-1)).toEqual({ sent: 1, applied: 1, badPatterns: [] });
});
it('sends a changed config to the running process at once', …);       // второй setConfig → версия 2, кадр в логе без нового epoch, applied === 2
it('re-sends the latest config, not the first one, after a crash', async () => {   // Review Focus 4
  const { dp, lines } = make(['--crash-after', '3']);
  dp.setConfig(D1); dp.start(); dp.attachPcm(new PassThrough(), 1);
  await until(() => dp.health().running);
  const D2 = { ...D1, chat: { ...D1.chat, minTriggerShare: 0.2 } }; dp.setConfig(D2);
  await until(() => dp.health().restarts >= 1 && dp.health().running);
  await until(() => lines().filter((l) => l.includes('"type":"config"')).length >= 3);
  const frames = lines().filter((l) => l.startsWith('1 ')).map((l) => JSON.parse(l.slice(2)));
  const afterRestart = frames.slice(frames.findLastIndex((f) => f.type === 'config'));
  expect(afterRestart[0]).toEqual({ type: 'config', version: 2, detector: D2 });
  expect(afterRestart[1]?.type).toBe('epoch');
});
it('reports patterns the detector could not use', …);                  // --bad-pattern '((' → configState().badPatterns toEqual ['((']
it('passes detail through on signals lines', …);                       // фиктивная строка signals с detail → событие 'signals' несёт тот же объект
```

- [ ] **Step 2: Run** `npx vitest run tests/service/detectorProcess.test.ts` — Expected: новые FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — Expected: PASS (включая прежние тесты файла).
- [ ] **Step 5: Commit** `feat: detector process sends profile settings and tracks acknowledgement`.

---

### Task 6: `Cutter` — параметры из профиля и решения

**Files:**
- Modify: `src/service/cutter.ts`
- Test: `tests/service/cutter.test.ts`

**Interfaces:**
- Consumes: `Profile` (Task 2), `FeedClip.profileId/profileName` (Task 2).
- Produces:

```ts
export interface CutterDeps { /* как сейчас */ profile: () => Profile }   // обязательное поле
export type CutDecision =
  | { kind: 'clip'; event: DetectorEvent; clipId: string }
  | { kind: 'limited'; event: DetectorEvent; limit: number; median: number }
  | { kind: 'paused'; event: DetectorEvent; reason: string };
// new event: 'decision' (CutDecision) — ровно одно на каждое событие детектора, переданное в onEvent
```

Поведение:
- `handleEvent` один раз читает `deps.profile()` и использует этот снимок до конца: `settings.cut.preRollMs`, `preRollLowConfidenceMs`, `postRollMs`, `maxClipMs`, `maxClipsPerHour`. Из `deps.config()` берутся только `libraryDir`, `diskReserveBytes`, `ffmpegPath`, `manualClipMs`.
- Автоклип получает `profileId`/`profileName` снимка; ручной клип — `null`/`null`.
- `clip.json` автоклипа: вместо прежнего `configVersion` от `cfg.detector` — `profile: { id, name, settings }` и `configVersion = sha1(JSON.stringify(settings))`. У ручного клипа `profile: null`, `configVersion` — `sha1('manual')`.
- `'decision'` с `kind: 'clip'` — сразу после вставки записи `pending`; `'limited'` — с `limit` из профиля и медианой, с которой сравнивали; `'paused'` — с текстом причины (тот же, что уходит в `'paused'`).

- [ ] **Step 1: Update the test harness and write the failing tests.** В `build()` добавить `profile: () => profile`, где `profile = { id: 'p1', name: 'Тест', isDefault: true, settings: settingsFromConfig(cfg), createdAt: '', updatedAt: '' }` — так существующие тесты с `build({ preRollMs: … })` продолжают работать. Новые тесты:

```ts
it('takes the roll and length limits from the profile at event time', async () => {
  build(); fill(1, 0, 80);
  profile.settings.cut = { ...profile.settings.cut, preRollMs: 4000, postRollMs: 2000 };
  cfg.preRollMs = 60000;                                   // общий конфиг больше не влияет
  await cutter.onEvent(event());                           // событие 100–110 с
  expect(lastRange()).toEqual([96, 112]);
});
it('stamps auto clips with the profile and manual clips with null', …);   // FeedClip.profileId/profileName; после смены profile.name следующий клип несёт новое имя
it('writes the profile snapshot and its hash into clip.json', …);         // json.profile toEqual { id, name, settings }; configVersion === sha1(JSON.stringify(settings))
it('reports a clip decision for a cut event', …);                         // [{ kind: 'clip', clipId: 'id-0001', event }]
it('reports events dropped by the hourly limiter with the limit and the median', async () => {
  build(); profile.settings.cut.maxClipsPerHour = 2; fill(1, 0, 200);
  const seen: CutDecision[] = []; cutter.on('decision', (d) => seen.push(d));
  await cutter.onEvent(event({ scores: { total: 4, share: 0, speed: 0, audio: 0 } }));
  await cutter.onEvent(event({ scores: { total: 6, share: 0, speed: 0, audio: 0 } }));
  await cutter.onEvent(event({ scores: { total: 3, share: 0, speed: 0, audio: 0 } }));
  expect(seen.at(-1)).toMatchObject({ kind: 'limited', limit: 2, median: 5 });
});
it('reports events dropped while cutting is paused', …);                  // paused = true → { kind: 'paused', reason: 'Нарезка приостановлена' }
```

- [ ] **Step 2: Run** `npx vitest run tests/service/cutter.test.ts` — Expected: новые FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat: cutter reads the stream profile and reports its decisions`.

---

### Task 7: `StreamRegistry` — профиль эфира, применение на ходу, журнал настройки

**Files:**
- Create: `src/service/tuningLog.ts`
- Modify: `src/service/streams.ts`
- Test: `tests/service/tuningLog.test.ts`, `tests/service/streams.test.ts`

**Interfaces:**
- Consumes: `ProfileService`, `Profile` (Task 2); `DetectorProcess.setConfig/configState`, событие `'config'`, `DetectorSignals.detail` (Task 5); `CutDecision` (Task 6).
- Produces:

```ts
// src/service/tuningLog.ts
export type TuningEntry =
  | { at: string; kind: 'nearmiss'; missing: string[]; values: Record<string, number> }
  | { at: string; kind: 'clip'; clipId: string; triggers: Trigger[]; scores: DetectorEvent['scores'] }
  | { at: string; kind: 'limited'; scores: DetectorEvent['scores']; limit: number; median: number }
  | { at: string; kind: 'paused'; scores: DetectorEvent['scores']; reason: string }
  | { at: string; kind: 'profile'; name: string; version: number; badPatterns: string[]; error?: string };
export const MAX_FRAMES = 300;
export const MAX_ENTRIES = 100;
export class TuningLog {
  addFrame(s: DetectorSignals): void;      // хранит последние MAX_FRAMES
  addEntry(e: TuningEntry): void;          // хранит последние MAX_ENTRIES
  snapshot(): { frames: DetectorSignals[]; entries: TuningEntry[] };   // старые первыми; копии массивов
}

// src/service/streams.ts
export interface StreamRegistryDeps { /* как сейчас */ profiles: ProfileService }
export interface StreamStatus { /* как сейчас */
  profile: { id: string; name: string };
  profileVersion: number;          // DetectorConfigState.sent
  profileApplied: number;          // DetectorConfigState.applied
  profileBadPatterns: string[];
}
class StreamRegistry {
  probe(url): Promise<Result<{ channel: string; qualities: string[]; profileId: string }>>;   // profileId = profiles.forChannel(channel).id
  start(url: string, quality: string, profileId?: string): Promise<Result<StreamStatus>>;
  setProfile(streamId: string, profileId: string): Result<StreamStatus>;
  profileInUse(profileId: string): boolean;
  tuning(streamId: string): { frames: DetectorSignals[]; entries: TuningEntry[] } | null;
}
// new event: 'tuning' ({ streamId: string; entry: TuningEntry })
```

Поведение:
- `start`: профиль — `profiles.get(profileId)` или, без `profileId`, `profiles.forChannel(channel)`; неизвестный id → `{ ok: false, error: 'Профиль не найден' }` до создания чего-либо. После успешного выбора — `profiles.remember(channel, id)`. В `create()` — `detector.setConfig(profile.settings.detector)` **до** `detector.start()`; `Cutter` получает `profile: () => profiles.get(stream.profileId) ?? profiles.defaultProfile()`.
- `setProfile`: неизвестный эфир → `'Эфир не найден'`, неизвестный профиль → `'Профиль не найден'`; иначе меняет `stream.profileId`, `detector.setConfig(…)`, `remember`, рассылает статус.
- Подписка на `profiles` в конструкторе: `'updated'` (p) → для каждого эфира с `profileId === p.id` — `detector.setConfig(p.settings.detector)` и статус; остальные эфиры не трогаются. Отписка в `shutdown()`.
- Журнал (`at` — `new Date().toISOString()`), каждая запись также уходит событием `'tuning'`: `detector 'signals'` → `addFrame`; `detector 'nearmiss'` → запись `nearmiss` (файл пишется как раньше); `cutter 'decision'` → `clip`/`limited`/`paused`; `detector 'config'` → запись `profile` с именем текущего профиля эфира.
- `isConflict` в `http.ts` не расширяется: `'Профиль не найден'` — 400.

- [ ] **Step 1: Write the failing tests.** `tests/service/tuningLog.test.ts`: `it('keeps the last 300 frames and 100 entries, oldest first', …)`, `it('snapshot returns copies', …)`.

`tests/service/streams.test.ts`: `FakeDetector` получает `configs: unknown[] = []`, `setConfig(d) { this.configs.push(d); return this.configs.length; }`, `configState() { return { sent: this.configs.length, applied: this.applied, badPatterns: [] }; }`; `build()` создаёт `profiles = new ProfileService(db, () => settingsFromConfig(cfg))` и передаёт его. Новые тесты:

```ts
it('starts a stream on the remembered profile and sends it before the detector starts', async () => {
  const big = ok(profiles.create('Крупный канал')); profiles.remember('alice', big.id);
  const r = await registry.start('https://twitch.tv/alice', 'best');
  expect(r.ok && r.value.profile).toEqual({ id: big.id, name: 'Крупный канал' });
  expect(detectors.get('alice')!.configs).toEqual([big.settings.detector]);
});
it('uses the given profile and remembers it for the channel', …);        // start(url, q, id) → profiles.forChannel('alice').id === id
it('refuses an unknown profile without starting anything', …);           // error 'Профиль не найден'; registry.list() пуст; runner.spawned пуст
it('applies a saved profile to every running stream on it and to no other', async () => {
  const other = ok(profiles.create('Другой'));
  await registry.start('https://twitch.tv/alice', 'best'); await registry.start('https://twitch.tv/bob', 'best');   // multiStream: true
  await registry.start('https://twitch.tv/carol', 'best', other.id);
  const next = structuredClone(profiles.defaultProfile().settings); next.detector.chat.minTriggerShare = 0.2;
  ok(profiles.update(profiles.defaultProfile().id, { settings: next }));
  expect(detectors.get('alice')!.configs.at(-1)).toEqual(next.detector);
  expect(detectors.get('bob')!.configs).toHaveLength(2);
  expect(detectors.get('carol')!.configs).toHaveLength(1);
});
it('switches the profile of a running stream', …);                        // setProfile → status.profile, второй setConfig, forChannel запомнил; clip после смены несёт новый profileName
it('reports unknown stream and unknown profile on setProfile', …);
it('knows which profiles are in use', …);                                 // profileInUse true/false; после stop — false
it('probe returns the remembered profile of the channel', …);
it('keeps frames and decisions for the tuning panel and emits them', async () => {
  const seen: any[] = []; registry.on('tuning', (e) => seen.push(e));
  const r = await registry.start('https://twitch.tv/alice', 'best'); const id = r.ok ? r.value.id : '';
  const d = detectors.get('alice')!;
  d.emit('signals', { tMs: 1000, chatSpike: 1, laughShare: 0, messages: 0, deltaDb: 0, vad: 0, warm: false });
  d.emit('nearmiss', { epoch: 1, tMs: 2000, kind: 'chat', missing: ['share'], values: { triggerShare: 0.03 } });
  d.applied = 1; d.emit('config', { sent: 1, applied: 1, badPatterns: ['(('] });
  const t = registry.tuning(id)!;
  expect(t.frames).toHaveLength(1);
  expect(t.entries.map((e) => e.kind)).toEqual(['nearmiss', 'profile']);
  expect(t.entries[1]).toMatchObject({ name: 'По умолчанию', version: 1, badPatterns: ['(('] });
  expect(seen).toHaveLength(2); expect(seen[0]).toMatchObject({ streamId: id, entry: { kind: 'nearmiss', missing: ['share'] } });
  expect(registry.tuning('nope')).toBeNull();
});
it('logs cutter decisions', …);                                           // событие детектора → запись kind 'clip' с clipId и scores
it('status carries the profile versions and bad patterns', …);
```

- [ ] **Step 2: Run** `npx vitest run tests/service/tuningLog.test.ts tests/service/streams.test.ts` — Expected: новые FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/service` — Expected: PASS, кроме `main.test.ts`/`http.test.ts`, если им уже не хватает `profiles` (их чинит Task 8; в этой задаче `runService` должен хотя бы компилироваться — передайте в реестр `new ProfileService(db, () => settingsFromConfig(cfg))`).
- [ ] **Step 5: Commit** `feat: per-stream profiles applied live, tuning log`.

---

### Task 8: HTTP API, SSE и запуск сервиса

**Files:**
- Modify: `src/service/http.ts`, `src/service/main.ts`, `README.md` (раздел «Сервис»)
- Test: `tests/service/http.test.ts`, `tests/service/main.test.ts`

**Interfaces:**
- Consumes: `ProfileService`, `ProfileResult` (Task 2); методы реестра и событие `'tuning'` (Task 7).
- Produces: `HttpDeps` получает `profiles: ProfileService`. Маршруты (все после проверки входа; тело читается через `readJson`, `readsBody` дополняется):

| Маршрут | Ответ |
| --- | --- |
| `GET /api/profiles` | 200 `Profile[]` |
| `POST /api/profiles` `{ name, copyFrom? }` | 201 `Profile`; ошибка — статус и текст из `ProfileResult` |
| `PUT /api/profiles/:id` `{ name?, settings? }` | 200 `Profile`; ошибка — `{ error, path? }` со статусом из `ProfileResult` |
| `DELETE /api/profiles/:id` | 204; `registry.profileInUse(id)` → 409 `'Профиль используется идущим эфиром'`; остальное — из `ProfileResult` |
| `POST /api/streams` `{ url, quality, profileId? }` | как сейчас; `profileId` не строка → 400 `'Некорректный запрос'` |
| `PUT /api/streams/:id/profile` `{ profileId }` | 200 `StreamStatus`; `'Эфир не найден'` → 404, `'Профиль не найден'` → 400 |
| `GET /api/streams/:id/tuning` | 200 `{ frames, entries }`; нет эфира → 404 `'Эфир не найден'` |
| `POST /api/probe` | в ответе добавляется `profileId` (отдаёт реестр) |
| `GET /api/state` | добавляется `profiles: Profile[]` |

SSE: `profiles` (`Profile[]`, по событию `'list'` сервиса профилей) и `tuning` (`{ streamId, entry }`, по событию реестра). Обработчики снимаются в `close()`.

`main.ts`: `const profiles = new ProfileService(db, () => settingsFromConfig(cfg))` создаётся сразу после `openDb` и передаётся в реестр и в `startHttp`. `fail()` для профильных ошибок кладёт `path` в тело, когда он есть.

README, раздел «Сервис»: пункт 4 переписать — пороги детектора и параметры нарезки правятся во вкладке «Профили»; значения из `config.json` используются один раз, при создании профиля «По умолчанию»; в `config.json` остаются общие настройки (перечислить). Добавить абзац про режим настройки (переключатель «Настройка» на карточке эфира).

- [ ] **Step 1: Write the failing tests.** В `tests/service/http.test.ts` `FakeRegistry` получает `setProfile`, `profileInUse = vi.fn(() => false)`, `tuning`; в `beforeEach` — настоящий `ProfileService` на базе в памяти. Тесты:

```ts
it('lists, creates, updates and deletes profiles', …);     // 200 / 201 / 200 / 204; GET после каждого шага
it('answers validation errors with the field path', async () => {
  const bad = structuredClone(def.settings); bad.detector.chat.windowS = 0;
  const r = await call('PUT', `/api/profiles/${def.id}`, { settings: bad });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: '«Окно подсчёта сообщений»: допустимо от 1 до 60', path: 'detector.chat.windowS' });
});
it('refuses to delete a profile used by a running stream', …);            // profileInUse → true: 409 'Профиль используется идущим эфиром', профиль на месте
it('refuses to delete the default profile and unknown ids', …);           // 409, 404
it('passes profileId to start and rejects a non-string one', …);          // registry.start toHaveBeenCalledWith(url, 'best', 'p2'); { profileId: 5 } → 400
it('switches the profile of a stream', …);                                // 200; 'Эфир не найден' → 404; 'Профиль не найден' → 400
it('serves the tuning history', …);                                       // 200 { frames: [], entries: [] }; null → 404
it('includes profiles in /api/state', …);
it('broadcasts profiles and tuning over SSE', …);                         // после PUT приходит event: profiles; registry.emit('tuning', …) → event: tuning
it('requires login for the profile routes', …);                           // 401 без cookie на GET/POST/PUT/DELETE
it('rejects profile writes from a foreign origin', …);                    // Origin: http://evil → 403
```

`tests/service/main.test.ts`: `it('creates the default profile from config.json on the first start and keeps edits across restarts', …)` — `config.json` с `preRollMs: 7000` и `detector.chat.minTriggerShare: 0.1`; после первого `runService` `GET /api/profiles` отдаёт профиль с этими значениями; изменить его через `PUT`, остановить, поменять `config.json`, запустить снова — профиль хранит правку, а не значение из файла.

- [ ] **Step 2: Run** `npx vitest run tests/service/http.test.ts tests/service/main.test.ts` — Expected: новые FAIL.
- [ ] **Step 3: Implement** routes, SSE, wiring; update README.
- [ ] **Step 4: Run** `npx vitest run` and `npm run typecheck` — Expected: всё PASS.
- [ ] **Step 5: Commit** `feat: profile and tuning http api`.

---

### Task 9: Веб — вкладка «Профили» и редактор

**Files:**
- Create: `src/web/tuning.ts`, `src/web/components/ProfileEditor.tsx`, `src/web/views/Profiles.tsx`
- Modify: `src/web/api.ts`, `src/web/App.tsx`, `src/web/styles.css`
- Test: `tests/web/tuning.test.ts`, `tests/web/ProfileEditor.test.tsx`, `tests/web/Profiles.test.tsx`, `tests/web/subscribe.test.ts`

**Interfaces:**
- Consumes: `FIELDS`, `GROUP_LABELS`, `DICTIONARIES`, `ProfileSettings` (Task 1, обычный импорт из `../service/profileSettings` — модуль чистый); `Profile` (Task 2, `import type`); `StreamStatus.profile/profileVersion/profileApplied/profileBadPatterns`, `TuningEntry` (Task 7); маршруты Task 8.
- Produces:

```ts
// src/web/api.ts
export class ApiError { /* как сейчас */ readonly path?: string }      // path из тела ошибки, если есть
export interface AppState { /* как сейчас */ profiles: Profile[] }
api.profiles(): Promise<Profile[]>
api.createProfile(name: string, copyFrom?: string): Promise<Profile>
api.updateProfile(id: string, patch: { name?: string; settings?: ProfileSettings }): Promise<Profile>
api.deleteProfile(id: string): Promise<void>
api.setStreamProfile(streamId: string, profileId: string): Promise<StreamStatus>
api.tuning(streamId: string): Promise<{ frames: DetectorSignals[]; entries: TuningEntry[] }>
api.startStream(url: string, quality: string, profileId?: string): Promise<StreamStatus>
api.probe(url): Promise<{ channel: string; qualities: string[]; profileId: string }>
SubscribeHandlers gains: profiles?: (p: Profile[]) => void; tuning?: (e: { streamId: string; entry: TuningEntry }) => void

// src/web/tuning.ts (в этой задаче — только разбор формы; остальное добавляет Task 10)
export function parseNumber(text: string): number | null;     // обрезает пробелы, запятая = точка; '' и нечисло → null
export type FormValues = Record<string, string>;              // path → текст поля; словари — текст с шаблоном на строку
export function toForm(s: ProfileSettings): FormValues;       // числа через num(x, 6) из format.ts (запятая), словари через '\n'
export function fromForm(f: FormValues): { ok: true; value: ProfileSettings } | { ok: false; path: string; error: string };
// fromForm: только разбор; числа, которые не разобрались → error `«${label}»: нужно число`; границы проверяет сервер

// src/web/components/ProfileEditor.tsx
export function ProfileEditor(props: { profile: Profile; streams: StreamStatus[]; onSaved?: (p: Profile) => void }): JSX.Element;
// src/web/views/Profiles.tsx
export function Profiles(props: { profiles: Profile[]; streams: StreamStatus[] }): JSX.Element;
```

Поведение `ProfileEditor`:
- Поля по группам в порядке `GROUP_LABELS`, затем «Словари». У каждого числового поля `<label>` с текстом `FieldDef.label`, единица, подсказка `hint` и пометка по `applies`: `now` → «со следующей секунды», `window` → «по мере набора данных». У словарей — `<textarea>` с подписью «Смех»/«Реакции» и подсказкой «по шаблону на строку; действует на новые сообщения». Поле названия — подпись «Название».
- Над формой, если профиль используют идущие эфиры: `Изменения сразу подействуют на эфиры: alice, bob`.
- «Сохранить» (и Enter в поле ввода): `fromForm` → при ошибке показать её у поля и не слать запрос; иначе `api.updateProfile(id, { name, settings })`. Ошибка сервера с `path` показывается у этого поля, без `path` — под кнопками. После успеха: `применено к эфирам: N` (N — идущие эфиры на профиле; при 0 — `сохранено`).
- «Отменить изменения» возвращает форму к `props.profile`. Обе кнопки неактивны, пока форма не изменена. Смена `props.profile.id` сбрасывает форму; обновление того же профиля извне (`updatedAt` изменился) сбрасывает форму, только если она не изменена.
- Предупреждение `Не используется детектором: <шаблоны через запятую>` — объединение `profileBadPatterns` эфиров на этом профиле, если не пусто.

Поведение `Profiles`: слева список (имя; «по умолчанию» у основного; под именем — каналы идущих эфиров на профиле), справа `ProfileEditor` выбранного (по умолчанию выбран первый). «Создать копию» — поле названия и кнопка «Создать» → `api.createProfile(name, selected.id)`, новый профиль становится выбранным. «Удалить» — `confirm('Удалить профиль «${name}»?')` → `api.deleteProfile`; кнопки нет у «По умолчанию», и она неактивна с подсказкой `title="Профиль используется идущим эфиром"`, если профиль в работе. Ошибки API — текстом под списком.

`App.tsx`: третий экран `'profiles'` и вкладка «Профили» после «Лента»; состояние `profiles` из `api.state()` и SSE `profiles`; обработчик SSE `tuning` складывает записи в `tuningLive: Record<string, TuningEntry[]>` (не больше 100 на эфир) — его использует Task 10.

- [ ] **Step 1: Write the failing tests.**

`tests/web/tuning.test.ts`:
```ts
it.each([['0,05', 0.05], [' 12 ', 12], ['1.5', 1.5], ['-3', -3]])('parses %s', (t, v) => expect(parseNumber(t)).toBe(v));   // Review Focus 1
it.each(['', '  ', 'abc', '1,2,3', '5 с'])('rejects %j', (t) => expect(parseNumber(t)).toBeNull());
it('round-trips the defaults through the form', () => expect(fromForm(toForm(SEED))).toEqual({ ok: true, value: SEED }));
it('shows decimals with a comma', () => expect(toForm(SEED)['detector.chat.minTriggerShare']).toBe('0,05'));
it('names the field that is not a number', () => {
  expect(fromForm({ ...toForm(SEED), 'cut.postRollMs': '' })).toEqual({ ok: false, path: 'cut.postRollMs', error: '«Запас после события»: нужно число' });
});
it('splits dictionaries by line', () => {
  const r = fromForm({ ...toForm(SEED), 'detector.chat.laughWords': '^lol$\r\n\n ^kek$ ' });
  expect(r.ok && r.value.detector.chat.laughWords).toEqual(['^lol$', '', ' ^kek$ ']);     // чистит сервер (Task 1)
});
```

`tests/web/ProfileEditor.test.tsx` (jsdom, `api` замокан как в `Streams.test.tsx`):
```ts
it('renders every field with its label and the current value', …);     // getByLabelText(/Доля активных, не меньше/) имеет value '0,05'; полей с числом — 28
it('warns which running streams the edit will hit', …);                 // 'Изменения сразу подействуют на эфиры: alice, bob'
it('saves parsed settings and reports how many streams got them', async () => {
  mocks.updateProfile.mockResolvedValue(P);
  view({ streams: [stream({ channel: 'alice', profile: { id: P.id, name: P.name } })] });
  fireEvent.change(screen.getByLabelText(/Доля активных, не меньше/), { target: { value: '0,08' } });
  fireEvent.click(screen.getByText('Сохранить'));
  await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalled());
  expect(mocks.updateProfile.mock.calls[0]![1].settings.detector.chat.minTriggerShare).toBe(0.08);
  expect(await screen.findByText('применено к эфирам: 1')).toBeTruthy();
});
it('does not send a request when a field is empty and shows the error at it', …);   // Review Focus 1: updateProfile не вызван; текст '«Запас после события»: нужно число'
it('shows a server validation error at the field it names', …);         // reject ApiError(400, '«Окно подсчёта сообщений»: допустимо от 1 до 60') с path
it('saves on Enter in an input', …);
it('reverts the form', …);                                              // после «Отменить изменения» значение прежнее, кнопки неактивны
it('keeps unsaved edits when the same profile is updated from outside', …);
it('lists patterns the detector does not use', …);                      // profileBadPatterns ['(('] → 'Не используется детектором: (('
```

`tests/web/Profiles.test.tsx`: `it('selects the first profile and switches on click', …)`; `it('creates a copy of the selected profile and selects it', …)` — `createProfile` вызван с `('Мелкий канал', selected.id)`; `it('hides delete for the default and disables it for a profile in use', …)`; `it('asks before deleting', …)` — `confirm` с текстом `Удалить профиль «Крупный канал»?`; при отказе `deleteProfile` не вызван; `it('shows the api error', …)`.

`tests/web/subscribe.test.ts`: `it('delivers profiles and tuning events', …)`.

- [ ] **Step 2: Run** `npx vitest run tests/web` — Expected: новые FAIL.
- [ ] **Step 3: Implement.** Стили — в `styles.css` теми же переменными (`--card`, `--line`, `--muted`, `--warn`, `--bad`); на экране уже 700 px список профилей встаёт над редактором.
- [ ] **Step 4: Run** `npx vitest run tests/web`, `npm run typecheck`, `npm run web:build` — Expected: PASS, сборка без ошибок.
- [ ] **Step 5: Commit** `feat(web): profiles tab and editor`.

---

### Task 10: Веб — выбор профиля эфира, панель настройки, профиль в ленте

**Files:**
- Create: `src/web/components/TuningPanel.tsx`, `src/web/components/Sparkline.tsx`
- Modify: `src/web/tuning.ts`, `src/web/views/Streams.tsx`, `src/web/components/StreamCard.tsx`, `src/web/components/ClipCard.tsx`, `src/web/App.tsx`, `src/web/styles.css`, `docs/smoke-checklist-service.md`
- Test: `tests/web/tuning.test.ts`, `tests/web/TuningPanel.test.tsx`, `tests/web/Streams.test.tsx`, `tests/web/ClipCard.test.tsx`

**Interfaces:**
- Consumes: всё из Task 9; `DetectorDetail` (Task 5); `TuningEntry` (Task 7).
- Produces:

```ts
// src/web/tuning.ts
export interface ConditionRow { ok: boolean; label: string; value: string; need: string }
export function conditionRows(d: DetectorDetail, s: ProfileSettings): ConditionRow[];   // ровно 4 строки, порядок: прогрев, сообщения, авторы, доля
export function verdict(d: DetectorDetail): string;
export function entryText(e: TuningEntry): string;
export function mergeFrames(a: DetectorSignals[], b: DetectorSignals[]): DetectorSignals[];  // по tMs без повторов, по возрастанию, последние 300
export function tuningStored(channel: string): boolean;                // localStorage 'hl.tuning.<channel>' === '1'; при недоступном хранилище — false
export function storeTuning(channel: string, on: boolean): void;       // ошибки хранилища проглатываются

// src/web/components/Sparkline.tsx
export function Sparkline(props: { values: number[]; max: number; threshold: number; label: string }): JSX.Element;   // inline SVG, aria-label = label
// src/web/components/TuningPanel.tsx
export function TuningPanel(props: { stream: StreamStatus; profile: Profile | undefined; liveEntries: TuningEntry[] }): JSX.Element;
// StreamCard получает props: { stream; profiles: Profile[]; liveEntries: TuningEntry[] }
// Streams получает props: profiles: Profile[]; tuningLive: Record<string, TuningEntry[]>
```

Точные тексты (числа через `num()`, проценты — `num(p * 100)` + ` %`):

- `conditionRows`:
  1. `прогрев` — value `идёт ${duration(sinceStartMs)}`, need `нужно ${warmupS} с`, ok = `conditions.warm`;
  2. `триггерных сообщений` — value `${triggerMessages}`, need `≥ ${minTriggerMessages}`;
  3. `авторов` — value `${triggerAuthors}`, need `≥ ${minTriggerAuthors}`;
  4. `доля активных` — value `${pct} (${triggerAuthors} из ${activeAuthors})`, need `≥ ${pct(minTriggerShare)}`.
- `verdict`: `сработало`, если `conditions.fired`; иначе `не сработало: не хватает ` + через запятую из `прогрева`, `сообщений`, `авторов`, `доли` (по ложным условиям).
- `entryText`:
  - `clip` → `клип ${total} · ${метки триггеров через ' + '} · доля ${share} + скорость ${speed} + звук ${audio}`;
  - `nearmiss` → `почти: не хватает ${…}` (`share` → `доли`, `authors` → `авторов`, `warm` → `прогрева`), затем `· ${triggerMessages} сообщ., ${triggerAuthors} авт., доля ${pct}` из `values`;
  - `limited` → `событие ${total} отброшено: лимит ${limit} клипов в час, медиана ${median}`;
  - `paused` → `событие ${total} отброшено: ${reason}`;
  - `profile` → `применён профиль «${name}»`; с `badPatterns` — добавить ` · не используется: ${…}`; с `error` — `профиль «${name}» не применён: ${error}`.

`TuningPanel`:
- При монтировании и при смене `stream.id` — `api.tuning(stream.id)`; кадры из ответа объединяются (`mergeFrames`) с приходящими в `stream.signals`; записи журнала — ответ плюс `liveEntries` без повторов (ключ `at` + `kind`), новые сверху, время через `clockTime` с секундами.
- Разделы по наброску из спека: «Срабатывание» (4 строки условий, каждая с классом `ok`/`bad`, и `verdict`); «Чат» (`${messages} сообщений за ${windowS} с · фон ${baseline} · скорость ×${spike} · смех ${laughMessages} · реакции ${reactionMessages}`); «Звук» (`${db} дБ · фон ${baselineDb} дБ · +${deltaDb} дБ (всплеск от +${spikeDb}) · голос ${vad} (от ${spikeVad})`); «Оценка» (`1 + доля ${share} + скорость ${speed} + звук ${audio} = ${total}`; при открытом событии — вторая строка `событие идёт ${duration} · оценка ${total}`); «За 5 минут» — два `Sparkline`: доля (`threshold = minTriggerShare`, `max = max(shareFull, наибольшее значение)`) и скорость (`threshold = endSpike`, `max = max(spikeFull, наибольшее значение)`); «Журнал».
- Нет `stream.signals?.detail` → `ждём данные детектора…`. Нет `profile` → пороги не показываются, значения остаются.
- Кнопка «Изменить профиль» раскрывает под панелью `ProfileEditor` текущего профиля.

`StreamCard`: в шапке `<select aria-label="Профиль">` со всеми профилями → `api.setStreamProfile`; рядом `применяется…`, пока `profileApplied < profileVersion`; флажок «Настройка» (начальное состояние `tuningStored(channel)`, изменение — `storeTuning`) показывает `TuningPanel`. Полоски «чат» и «звук» остаются.

`Streams`: после «Проверить» рядом с качеством `<select aria-label="Профиль">`, выбран `profileId` из ответа `probe`; «Начать» шлёт `api.startStream(url, quality, profileId)`.

`ClipCard`: в строке с временем и оценкой, если `clip.profileName`, добавить ` · профиль ${profileName}`.

`docs/smoke-checklist-service.md`: новый раздел «Profiles and tuning mode» — шаги живой проверки из Step 6.

- [ ] **Step 1: Write the failing tests.**

`tests/web/tuning.test.ts` (D — `detail` из примера Task 4, S — настройки по умолчанию):
```ts
it('builds the four condition rows against the profile thresholds', () => {
  expect(conditionRows(D, S)).toEqual([
    { ok: true, label: 'прогрев', value: 'идёт 12 мин', need: 'нужно 60 с' },
    { ok: true, label: 'триггерных сообщений', value: '5', need: '≥ 3' },
    { ok: true, label: 'авторов', value: '4', need: '≥ 2' },
    { ok: false, label: 'доля активных', value: '3,1 % (4 из 128)', need: '≥ 5 %' },
  ]);
});
it('says what is missing', () => {
  expect(verdict(D)).toBe('не сработало: не хватает доли');
  expect(verdict({ ...D, conditions: { warm: false, messages: false, authors: true, share: true, fired: false } })).toBe('не сработало: не хватает прогрева, сообщений');
  expect(verdict({ ...D, conditions: { ...D.conditions, share: true, fired: true } })).toBe('сработало');
});
it('describes log entries', () => {
  expect(entryText({ at: '', kind: 'clip', clipId: 'c', triggers: ['laugh', 'audio'], scores: { total: 4.3, share: 1, speed: 1.8, audio: 0.5 } }))
    .toBe('клип 4,3 · смех + звук · доля 1 + скорость 1,8 + звук 0,5');
  expect(entryText({ at: '', kind: 'limited', scores: { total: 2.1, share: 0, speed: 0, audio: 0 }, limit: 20, median: 3.4 }))
    .toBe('событие 2,1 отброшено: лимит 20 клипов в час, медиана 3,4');
  expect(entryText({ at: '', kind: 'nearmiss', missing: ['share'], values: { triggerMessages: 5, triggerAuthors: 4, triggerShare: 0.031 } }))
    .toBe('почти: не хватает доли · 5 сообщ., 4 авт., доля 3,1 %');
  expect(entryText({ at: '', kind: 'profile', name: 'Крупный канал', version: 2, badPatterns: [] })).toBe('применён профиль «Крупный канал»');
  expect(entryText({ at: '', kind: 'profile', name: 'А', version: 2, badPatterns: [], error: 'x' })).toBe('профиль «А» не применён: x');
});
it('merges frames by time without duplicates and keeps the last 300', …);
it('survives a blocked localStorage', …);    // getItem/setItem бросают → tuningStored false, storeTuning не бросает
```

`tests/web/TuningPanel.test.tsx`:
```ts
it('loads the history and shows the conditions, the verdict and the log', …);   // api.tuning вызван с 's1'; видны 'доля активных', 'не сработало: не хватает доли', текст записи журнала
it('marks failed conditions', …);                                                // строка доли имеет класс 'bad', остальные 'ok'
it('adds live entries on top without duplicates', …);
it('waits for detector data', …);                                                // signals: null → 'ждём данные детектора…'
it('draws two sparklines with the thresholds of the profile', …);                // getByLabelText('доля') и getByLabelText('скорость')
it('opens the editor of the stream profile', …);                                 // клик «Изменить профиль» → видно поле «Название» со значением имени профиля
```

`tests/web/Streams.test.tsx`: `it('preselects the remembered profile and starts with the chosen one', …)` — `probe` → `{ …, profileId: 'p2' }`, select «Профиль» имеет value `p2`; после выбора `p1` и «Начать» — `startStream('…', 'best', 'p1')`; `it('switches the profile on the card', …)`; `it('shows «применяется…» until the detector acknowledges', …)` — `profileVersion: 2, profileApplied: 1`; `it('remembers the tuning switch per channel', …)` — после клика `localStorage['hl.tuning.shroud'] === '1'`, повторный рендер открывает панель сразу.

`tests/web/ClipCard.test.tsx`: `it('shows the profile a clip was cut with', …)` — `профиль Крупный канал`; клип с `profileName: null` — слова «профиль» нет.

- [ ] **Step 2: Run** `npx vitest run tests/web` — Expected: новые FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck`, `npm run web:build`, и из `detector` — `.venv/Scripts/python.exe -m pytest -q`. Expected: всё PASS.
- [ ] **Step 5: Commit** `feat(web): stream profile select, tuning panel, profile in feed`.
- [ ] **Step 6: Live check** (записать результат в `docs/smoke-checklist-service.md`, отдельный коммит `docs: live check of profiles and tuning mode`). `npm run service:build`, `npm run service`, войти, запустить эфир любого идущего канала:
  1. Во вкладке «Профили» есть «По умолчанию» со значениями из `config.json`.
  2. Создать копию «Тест», выбрать её на карточке эфира — «применяется…» исчезает за 1–2 с, в журнале `применён профиль «Тест»`.
  3. Включить «Настройка»: значения обновляются раз в секунду, графики растут.
  4. Изменить «Доля активных, не меньше» на 0,5 и сохранить — порог в строке условия и линия на графике меняются за 1–2 с; значок «детектор не работает» не появлялся, прогрев в панели не начался заново.
  5. Вписать в «Смех» шаблон `^([ах]+)+$` — сохранение отклонено с объяснением.
  6. Остановить эфир, удалить «Тест», снова проверить канал — в форме запуска выбран «По умолчанию».

---

## Self-check before handing back

`npx vitest run` — все проходят; `npm run typecheck` — без ошибок; `.venv/Scripts/python.exe -m pytest -q` в `detector` — все проходят; `git status` — чисто.

