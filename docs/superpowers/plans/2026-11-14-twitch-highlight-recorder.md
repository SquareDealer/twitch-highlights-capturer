# Twitch Highlight Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows-приложение на Electron: смотреть один Twitch-канал через официальный Embed, параллельно писать 5-минутный кольцевой буфер, ставить маркеры `1-9`, собирать и обрезать клипы в редакторе, сохранять MP4 + `markers.json` локально и синхронизировать в Google Drive.

**Architecture:** Main-процесс владеет всем состоянием: `CaptureSessionManager` (Streamlink → FFmpeg segment muxer), `RingBufferManager` (индекс сегментов + закрепления), `TimeSynchronizer` (wall-clock → время записи), сервисы моментов/черновиков/экспорта и две очереди задач в SQLite (`export`, `sync`). Renderer (React) — тонкий UI поверх IPC; он отдаётся локальным HTTP-сервером на `http://localhost:<port>`, чтобы Twitch Embed принял `parent=localhost`. Горячие клавиши ловит main через `before-input-event`, чтобы они работали и при фокусе внутри iframe плеера.

**Tech Stack:** Electron, electron-vite, React, TypeScript, better-sqlite3, vitest, `google-auth-library` + `@googleapis/drive`, electron-builder (NSIS). Внешние бинарники: `streamlink`, `ffmpeg` (из PATH или путь в настройках).

**Spec:** `docs/superpowers/specs/2026-11-14-twitch-highlight-recorder-design.md`

## Global Constraints

- Платформа: Windows 10/11 x64. Код main не использует POSIX-only API; пути только через `node:path`.
- Транскрибации нет: никаких Whisper, `transcript.json`, очереди транскрибации. Клип = `<slug>.mp4` + `markers.json`.
- Одновременно один канал, одна сессия захвата, один процесс Streamlink и один FFmpeg.
- Просмотр только через официальный Twitch Embed (`https://player.twitch.tv/js/embed/v1.js`, `parent: ['localhost']`). Записанные сегменты в режиме просмотра не воспроизводятся; `<video>` используется только в редакторе для черновика.
- Числа из спеки (дефолты `Settings`): буфер 300 с; сегмент 2 с; повтор F8 180 с; дозапись после F8 5 с; закрепление маркера 30 с до / 60 с после.
- Сегменты и черновики пишутся без перекодирования (`-c copy`); перекодирование только в финальном экспорте (точная обрезка).
- Все времена в коде — целые миллисекунды. `sourceTimeMs` — время на шкале записи внутри эпохи (`epoch`); эпоха увеличивается при каждом переподключении.
- Хоткеи локальные (только когда окно приложения в фокусе); `globalShortcut` не используется.
- Секреты (OAuth-токены) хранятся только через `safeStorage`, не в SQLite и не в логах.
- Тексты UI — на русском.
- Тесты: `npm test` (vitest, запускается под Node из Electron, чтобы ABI better-sqlite3 совпадал). Тесты, которым нужен реальный `ffmpeg`, помечаются `describe.skipIf(!hasFfmpeg)`.
- Коммит после каждой задачи, сообщения в стиле Conventional Commits.

## Принятые решения (спека их не фиксирует)

1. **Привязка маркера ко времени.** `sourceTime(wall) = wall − offset(epoch)`, где `offset = min(completedAtWallMs − endMs)` по сегментам эпохи. Маркер: `sourceTime(wallНажатия) − (embedLatencyMs − captureLatencyMs) + markerOffsetMs`. `embedLatencyMs` — последнее значение `hlsLatencyBroadcaster` из Embed (опрос раз в 1 с), при отсутствии — `defaultEmbedLatencyMs = 4000`. `captureLatencyMs = 3000` (Streamlink с `--twitch-low-latency`). Оба значения и `markerOffsetMs = 0` правятся в настройках; точная доводка — перетаскиванием в редакторе.
2. **Индекс сегментов** — из CSV-списка FFmpeg (`-segment_list … -segment_list_type csv`), `startMs/endMs` нормируются относительно старта первого сегмента эпохи.
3. **Черновик** — это MP4, склеенный `concat -c copy` из сегментов; он переживает перезапуск. Сырые сегменты при старте приложения удаляются.
4. **Жизненный цикл момента:** `ACTIVE → EXPORTING → SAVED | FAILED`, `DISCARDED`. По `Ctrl+S` сразу создаётся новый `ACTIVE`-момент; маркеры вне диапазона черновика переносятся в него; маркеры внутри черновика, но вне trim, в клип не попадают. При ошибке экспорта момент `FAILED`, черновик и маркеры целы, экспорт можно повторить.
5. **Закрепления** хранятся в памяти, владелец — id маркера или id черновика. Лимит `maxPinnedBytes = 2 ГиБ`: при превышении показывается предупреждение, автоматически закреплённое не удаляется никогда.
6. **Остановка захвата/выход:** если у активного момента есть маркеры и нет черновика, черновик собирается автоматически из закреплённого диапазона — маркеры не теряются.
7. **`streamId`** берётся из `streamlink --json` (`metadata.id`); тот же вызов проверяет, что канал в эфире.
8. **Чат не встраивается** (только видео): фокус внутри чужого iframe определить нельзя, а цифры не должны срабатывать при наборе в чате.
9. **Google OAuth:** пользователь вводит свой Client ID/Secret (тип Desktop) в настройках; loopback-редирект + PKCE; scope `drive.file`.
10. **Экспорт перекодирует** (`libx264 -preset veryfast -crf 20`, `aac 160k`), чтобы обрезка и смещения маркеров были покадрово точными.

## Review Focus

1. Название клипа с запрещёнными в Windows символами (`<>:"/\|?*`), кириллицей, пустое, зарезервированное (`CON`, `NUL`), с точкой/пробелом на конце → всегда валидная папка и файл, пустое → `clip`. Тест: Task 8 (`paths.test.ts`).
2. Цифра нажата при вводе текста, с модификатором (`Ctrl+1`), удержанием (auto-repeat), в режиме редактора → маркер не создаётся. Тест: Task 9 (`hotkeys.test.ts`).
3. Маркер/F8, когда записи нет или буфер ещё пуст (`IDLE`, `CONNECTING`, `RECONNECTING`, первые секунды), и F8 при буфере короче 180 с → без падения: маркер отклоняется с понятным уведомлением, F8 даёт черновик из того, что есть, либо уведомление. Тесты: Task 6 и Task 7.
4. Статистика Embed недоступна (`null`, `NaN`, реклама, плеер не готов) или даёт абсурд (> 60 с) → маркер создаётся с дефолтной задержкой, `sourceTimeMs ≥ 0`. Тест: Task 4.
5. Drive: нет сети, отозванный токен, выход из приложения посреди загрузки, повторная синхронизация → клип остаётся локально, задача повторяется с backoff, после перезапуска `running`-задачи возвращаются в очередь, дубликаты папок/файлов в Drive не создаются. Тесты: Task 8 (`jobQueue.test.ts`) и Task 12 (`syncWorker.test.ts`).

## File Structure

```
package.json · electron.vite.config.ts · vitest.config.ts · tsconfig.json · electron-builder.yml · README.md
src/shared/types.ts            доменные типы, Settings, контракт IPC (ThrApi, события)
src/shared/time.ts             чистые функции: toClipMarkers, formatTimecode
src/main/index.ts              bootstrap: окно, сервер, сборка сервисов, жизненный цикл
src/main/settings.ts           SettingsStore (таблица settings, дефолты)
src/main/db/index.ts           openDb + миграции (schema в том же файле)
src/main/db/repos.ts           репозитории: sessions, segments, moments, markers, drafts, clips, driveFiles
src/main/capture/segmentList.ts   парсер CSV-строк FFmpeg
src/main/capture/ringBuffer.ts    RingBufferManager
src/main/capture/timeSync.ts      TimeSynchronizer
src/main/capture/processes.ts     probeStream, spawnCapture, сборка аргументов
src/main/capture/sessionManager.ts CaptureSessionManager
src/main/moments/momentService.ts  маркеры и жизненный цикл момента
src/main/moments/draftService.ts   сборка/расширение/удаление черновиков
src/main/export/paths.ts          slugify, раскладка папок
src/main/export/exporter.ts       обработчик задачи export
src/main/jobs/jobQueue.ts         JobQueue поверх таблицы jobs
src/main/drive/auth.ts            OAuth loopback + safeStorage
src/main/drive/driveClient.ts     ensureFolder / uploadFile
src/main/drive/syncWorker.ts      обработчик задачи sync
src/main/server.ts                локальный HTTP: статика renderer + /media/drafts с Range
src/main/hotkeys.ts               resolveHotkey (чистая) + привязка к before-input-event
src/main/ipc.ts                   регистрация ipcMain-обработчиков
src/preload/index.ts              contextBridge → window.thr
src/renderer/src/App.tsx · store.ts · views/{WatchView,EditorView,LibraryView,SettingsView}.tsx
src/renderer/src/components/{TwitchPlayer,MarkerPrompt,StatusBar,Timeline,Notices}.tsx
tests/**                          зеркалит src (tests/main/capture/ringBuffer.test.ts и т.д.)
```

---

### Task 1: Каркас проекта и общие типы

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `.gitignore`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`, `src/shared/types.ts`, `src/shared/time.ts`
- Test: `tests/shared/time.test.ts`

**Interfaces:**
- Produces (`src/shared/types.ts`), этими именами пользуются все задачи:

```ts
export type MarkerType = 1|2|3|4|5|6|7|8|9;
export type CaptureState = 'IDLE'|'CONNECTING'|'RECORDING'|'RECONNECTING'|'STOPPING'|'ERROR';
export interface CaptureSession { id: string; streamer: string; streamId: string; state: CaptureState; startedAt: string; epoch: number; error?: string }
export interface Segment { sessionId: string; epoch: number; seq: number; path: string; startMs: number; endMs: number; bytes: number; completedAtWallMs: number }
export interface SourceTime { epoch: number; sourceTimeMs: number }
export interface Marker { id: string; momentId: string; epoch: number; type: MarkerType; sourceTimeMs: number; comment: string }
export type MomentStatus = 'ACTIVE'|'EXPORTING'|'SAVED'|'FAILED'|'DISCARDED';
export interface Moment { id: string; streamSessionId: string; status: MomentStatus; draftId: string|null; markers: Marker[] }
export interface Draft { id: string; sessionId: string; epoch: number; startMs: number; endMs: number; filePath: string; createdAt: string }
export type SyncStatus = 'pending'|'synced'|'failed';
export interface Clip { id: string; momentId: string; sessionId: string; title: string; dir: string; mp4Path: string; markersPath: string; durationMs: number; createdAt: string; syncStatus: SyncStatus }
export interface ClipMarker { id: string; type: MarkerType; timeMs: number; comment: string }
export interface Settings {
  libraryDir: string; bufferDir: string; streamlinkPath: string; ffmpegPath: string; quality: string; lastChannel: string;
  bufferSeconds: number; segmentSeconds: number; replaySeconds: number; replayTailSeconds: number;
  pinBeforeMs: number; pinAfterMs: number; maxPinnedBytes: number;
  captureLatencyMs: number; defaultEmbedLatencyMs: number; markerOffsetMs: number;
  driveAutoSync: boolean; driveClientId: string; driveClientSecret: string;
}
export interface UiState { mode: 'watch'|'editor'|'other'; textInputFocused: boolean }
export interface Notice { level: 'info'|'warn'|'error'; message: string }
export interface CaptureStatus { session: CaptureSession|null; bufferedMs: number; pinnedBytes: number; markerCount: number }
export interface ExportRequest { draftId: string; trimStartMs: number; trimEndMs: number; title: string } // trim — относительно начала черновика
```

- Produces (`src/shared/time.ts`):
  - `toClipMarkers(markers: Marker[], draft: Pick<Draft,'epoch'|'startMs'>, trimStartMs: number, trimEndMs: number): ClipMarker[]`
  - `formatTimecode(ms: number): string` — `mm:ss.SSS`, минуты не ограничены 59.
- `ThrApi` (контракт IPC) объявляется в `types.ts` в Task 9.

- [ ] **Step 1: Инициализировать проект.** `git init`; scaffold electron-vite (шаблон react-ts) в корень; добавить зависимости `better-sqlite3`, `google-auth-library`, `@googleapis/drive`; dev: `vitest`, `cross-env`, `electron-builder`, `@types/better-sqlite3`. Скрипты:

```json
"dev": "electron-vite dev",
"build": "electron-vite build",
"test": "cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run",
"postinstall": "electron-builder install-app-deps",
"dist": "electron-vite build && electron-builder --win nsis"
```

`vitest.config.ts`: `environment: 'node'`, `pool: 'forks'`, `include: ['tests/**/*.test.ts']`, алиас `@shared → src/shared`. Экспортировать из `tests/helpers.ts` `hasFfmpeg` (результат `spawnSync('ffmpeg', ['-version'])`) и `tmpDir()` (уникальная папка в `os.tmpdir()`, удаляется в `afterEach`).

- [ ] **Step 2: Написать падающий тест `tests/shared/time.test.ts`**

```ts
const m = (id: string, epoch: number, t: number): Marker => ({ id, momentId: 'm', epoch, type: 2, sourceTimeMs: t, comment: '' });
test('пример из спеки: маркер 02:10, начало обрезки 01:40 → 00:30', () => {
  expect(toClipMarkers([m('a', 0, 130_000)], { epoch: 0, startMs: 0 }, 100_000, 180_000))
    .toEqual([{ id: 'a', type: 2, timeMs: 30_000, comment: '' }]);
});
test('учитывает начало черновика, отбрасывает маркеры вне trim и чужой эпохи, сортирует', () => {
  const out = toClipMarkers([m('late', 0, 70_000), m('in', 0, 65_000), m('before', 0, 61_000), m('after', 0, 81_000), m('other', 1, 65_000)],
    { epoch: 0, startMs: 60_000 }, 2_000, 20_000);
  expect(out.map(x => [x.id, x.timeMs])).toEqual([['in', 3_000], ['late', 8_000]]);
});
test('границы trim включительно', () => {
  expect(toClipMarkers([m('s', 0, 1_000), m('e', 0, 5_000)], { epoch: 0, startMs: 0 }, 1_000, 5_000).map(x => x.timeMs)).toEqual([0, 4_000]);
});
test('formatTimecode', () => {
  expect(formatTimecode(151_420)).toBe('02:31.420');
  expect(formatTimecode(0)).toBe('00:00.000');
  expect(formatTimecode(3_723_004)).toBe('62:03.004');
});
```

- [ ] **Step 3: Запустить — убедиться, что падает.** Run: `npm test` → FAIL (нет `toClipMarkers`).
- [ ] **Step 4: Создать `src/shared/types.ts` (блок Interfaces дословно) и реализовать `src/shared/time.ts`.**
- [ ] **Step 5: Проверить.** Run: `npm test` → PASS; `npm run dev` → открывается окно с заглушкой «Twitch Highlight Recorder».
- [ ] **Step 6: Commit** — `chore: scaffold electron app, shared types and time helpers`.

---

### Task 2: SQLite и настройки

**Files:**
- Create: `src/main/db/index.ts`, `src/main/db/repos.ts`, `src/main/settings.ts`
- Test: `tests/main/db/repos.test.ts`, `tests/main/settings.test.ts`

**Interfaces:**
- Consumes: типы из Task 1.
- Produces:
  - `openDb(file: string): Database` (`':memory:'` в тестах; `journal_mode=WAL`, `foreign_keys=ON`, миграции по `PRAGMA user_version`).
  - `createRepos(db): Repos`, где

```ts
interface Repos {
  sessions: { insert(s: CaptureSession): void; update(id: string, patch: Partial<CaptureSession> & { endedAt?: string }): void; get(id: string): CaptureSession|null };
  segments: { insert(s: Segment): void; remove(sessionId: string, epoch: number, seq: number): void; clear(): void };
  moments:  { insert(m: Omit<Moment,'markers'>): void; get(id: string): Moment|null; activeFor(sessionId: string): Moment|null;
              forDraft(draftId: string): Moment|null; setStatus(id: string, s: MomentStatus): void; setDraft(id: string, draftId: string|null): void;
              listByStatus(s: MomentStatus): Moment[] };
  markers:  { insert(m: Marker): void; update(id: string, patch: Partial<Pick<Marker,'type'|'sourceTimeMs'|'comment'|'momentId'>>): void; remove(id: string): void; get(id: string): Marker|null };
  drafts:   { insert(d: Draft): void; update(id: string, patch: Partial<Pick<Draft,'startMs'|'endMs'>>): void; get(id: string): Draft|null; list(): Draft[]; remove(id: string): void };
  clips:    { insert(c: Clip): void; get(id: string): Clip|null; list(): Clip[]; setSyncStatus(id: string, s: SyncStatus): void };
  driveFiles: { get(clipId: string, kind: 'mp4'|'markers'): DriveFileRow|null; upsert(r: DriveFileRow): void;
                getFolder(pathKey: string): string|null; setFolder(pathKey: string, driveId: string): void };
}
interface DriveFileRow { clipId: string; kind: 'mp4'|'markers'; driveFileId: string; version: string; md5: string; status: 'synced'|'failed' }
```

  - `class SettingsStore { constructor(db, defaults: Settings); get(): Settings; set(patch: Partial<Settings>): Settings }` и `defaultSettings(paths: { videos: string; userData: string }): Settings`.

Таблицы: `capture_sessions`, `buffer_segments`, `moments`, `markers`, `drafts`, `clips`, `jobs` (создаётся здесь, используется в Task 8: `id, type, payload, status, attempts, next_run_at, last_error, dedupe_key, created_at`), `drive_files`, `drive_folders(path_key PRIMARY KEY, drive_id)`, `settings(key PRIMARY KEY, value)`. `moments.forDraft` возвращает момент с `draft_id = ?` и статусом `FAILED` или `EXPORTING`, иначе `ACTIVE`-момент сессии черновика. `Moment.markers` всегда отсортированы по `(epoch, sourceTimeMs)`.

Дефолты `Settings`: `libraryDir = <videos>/TwitchHighlights`, `bufferDir = <userData>/buffer`, `streamlinkPath = 'streamlink'`, `ffmpegPath = 'ffmpeg'`, `quality = 'best'`, `lastChannel = ''`, `bufferSeconds 300`, `segmentSeconds 2`, `replaySeconds 180`, `replayTailSeconds 5`, `pinBeforeMs 30000`, `pinAfterMs 60000`, `maxPinnedBytes 2147483648`, `captureLatencyMs 3000`, `defaultEmbedLatencyMs 4000`, `markerOffsetMs 0`, `driveAutoSync true`, `driveClientId ''`, `driveClientSecret ''`.

- [ ] **Step 1: Написать падающие тесты**

```ts
// repos.test.ts
test('момент возвращается с маркерами, отсортированными по (epoch, sourceTimeMs)', ...); // вставить 3 маркера вразнобой
test('activeFor возвращает только ACTIVE-момент сессии', ...);
test('forDraft: FAILED-момент с этим draftId важнее ACTIVE-момента сессии', ...);
test('markers.update переносит маркер в другой момент (momentId)', ...);
test('driveFiles.upsert заменяет строку по (clipId, kind)', ...);
test('повторный openDb того же файла не пересоздаёт таблицы и сохраняет данные', ...);
// settings.test.ts
test('get() без записей возвращает дефолты спеки', () => {
  const s = store.get();
  expect([s.bufferSeconds, s.segmentSeconds, s.replaySeconds, s.replayTailSeconds, s.pinBeforeMs, s.pinAfterMs]).toEqual([300, 2, 180, 5, 30_000, 60_000]);
});
test('set() сохраняет patch и переживает новый экземпляр SettingsStore', ...);
test('неизвестные ключи и значения неверного типа в set() игнорируются', ...);
```

- [ ] **Step 2: Запустить — падает.** Run: `npm test -- tests/main/db tests/main/settings` → FAIL.
- [ ] **Step 3: Реализовать `openDb`, `createRepos`, `SettingsStore`.** Значения настроек — JSON в `settings.value`.
- [ ] **Step 4: Запустить — проходит.** Тот же запуск → PASS.
- [ ] **Step 5: Commit** — `feat: sqlite schema, repositories and settings store`.

---

### Task 3: Индекс сегментов и кольцевой буфер

**Files:**
- Create: `src/main/capture/segmentList.ts`, `src/main/capture/ringBuffer.ts`
- Test: `tests/main/capture/segmentList.test.ts`, `tests/main/capture/ringBuffer.test.ts`

**Interfaces:**
- Consumes: `Segment`, `Repos['segments']`.
- Produces:
  - `parseSegmentLine(line: string): { file: string; startSec: number; endSec: number } | null` — строка CSV `seg_000012.ts,24.033000,26.066000`; `null` для пустой, неполной (без завершающего числа) и битой строки.
  - `class SegmentListTailer { constructor(csvPath: string, onEntry: (e: {file; startSec; endSec}) => void); start(): void; stop(): void; poll(): void }` — опрос файла каждые 250 мс, читает только новые байты, обрабатывает только строки, оканчивающиеся на `\n`.
  - `class RingBufferManager extends EventEmitter`:

```ts
constructor(opts: { segments: Repos['segments']; retentionMs: number; maxPinnedBytes: number; now?: () => number; unlink?: (p: string) => Promise<void> })
add(seg: Segment): void
pin(ownerId: string, epoch: number, startMs: number, endMs: number): void   // повторный pin того же владельца заменяет диапазон
unpin(ownerId: string): void
cleanup(): Promise<void>                // удаляет: completedAtWallMs < now − retentionMs И не пересекается ни с одним pin
select(epoch: number, startMs: number, endMs: number): Segment[]            // пересекающиеся с диапазоном, по seq
latest(epoch: number): Segment | null
bufferedMs(): number                    // сумма (endMs − startMs) незакреплённых и закреплённых сегментов текущей (максимальной) эпохи в окне retention
pinnedBytes(): number
clearAll(): Promise<void>               // удаляет все файлы и записи (старт приложения / после stop)
// события: 'segment' (Segment), 'pinLimit' ({ pinnedBytes, maxPinnedBytes }) — один раз при переходе через лимит, повторно после возврата под лимит
```

- [ ] **Step 1: Написать падающие тесты**

```ts
// segmentList.test.ts
test('разбирает строку csv', () => expect(parseSegmentLine('seg_000012.ts,24.033000,26.066000')).toEqual({ file: 'seg_000012.ts', startSec: 24.033, endSec: 26.066 }));
test.each(['', 'seg_1.ts,1.0', 'seg_1.ts,a,b', 'seg_1.ts,2.0,1.0'])('отклоняет %j', l => expect(parseSegmentLine(l)).toBeNull());
test('tailer отдаёт только завершённые строки и не повторяет уже прочитанные', ...); // дописать пол-строки → 0 событий; дописать остаток+\n → 1 событие
// ringBuffer.test.ts  (now управляется из теста, unlink — заглушка, собирающая пути)
test('cleanup удаляет незакреплённые сегменты старше 300 с и оставляет свежие', ...);
test('сегмент, пересекающий pin [t−30с, t+60с], не удаляется, даже если ему 20 минут', ...);
test('после unpin тот же сегмент удаляется следующим cleanup', ...);
test('сегмент, закреплённый двумя владельцами, живёт, пока не сняты оба', ...);
test('pin относится только к своей эпохе', ...);
test('select возвращает сегменты, частично пересекающие диапазон, в порядке seq', ...);
test('pinLimit испускается один раз при превышении maxPinnedBytes и ничего не удаляет', ...);
test('ошибка unlink (файл занят) не роняет cleanup, сегмент остаётся в индексе до следующей попытки', ...);
```

- [ ] **Step 2: Запустить — падает.** Run: `npm test -- tests/main/capture/segmentList tests/main/capture/ringBuffer` → FAIL.
- [ ] **Step 3: Реализовать `segmentList.ts` и `ringBuffer.ts`.** Индекс — в памяти (`Map<epoch, Segment[]>`), таблица `buffer_segments` зеркалируется через `segments.insert/remove`.
- [ ] **Step 4: Запустить — проходит.**
- [ ] **Step 5: Commit** — `feat: segment list tailer and ring buffer with pinning`.

---

### Task 4: TimeSynchronizer

**Files:**
- Create: `src/main/capture/timeSync.ts`
- Test: `tests/main/capture/timeSync.test.ts`

**Interfaces:**
- Consumes: `Segment`, `SourceTime`, `Settings` (поля `captureLatencyMs`, `defaultEmbedLatencyMs`, `markerOffsetMs`).
- Produces:

```ts
class TimeSynchronizer {
  constructor(getSettings: () => Pick<Settings,'captureLatencyMs'|'defaultEmbedLatencyMs'|'markerOffsetMs'>)
  onSegment(seg: Pick<Segment,'epoch'|'endMs'|'completedAtWallMs'>): void
  reportEmbedLatency(ms: number | null): void        // null/NaN/<0/>60000 → значение считается отсутствующим
  captureNow(wallMs: number): SourceTime | null      // null, пока в текущей эпохе нет ни одного сегмента
  markerTime(wallMs: number): SourceTime | null      // формула из «Принятых решений» п.1; sourceTimeMs округлён и ≥ 0
  reset(): void
}
```

Текущая эпоха — максимальная из виденных в `onSegment`. Значение задержки Embed старше 10 с (по `wallMs` последнего `reportEmbedLatency`, время берётся из `Date.now` через инжектируемый `now`) считается отсутствующим.

- [ ] **Step 1: Написать падающие тесты**

```ts
const cfg = { captureLatencyMs: 3000, defaultEmbedLatencyMs: 4000, markerOffsetMs: 0 };
test('captureNow: offset = min(completedAtWallMs − endMs) по эпохе', () => {
  ts.onSegment({ epoch: 0, endMs: 2000, completedAtWallMs: 1_002_600 });
  ts.onSegment({ epoch: 0, endMs: 4000, completedAtWallMs: 1_004_100 });   // min offset = 1_000_100
  expect(ts.captureNow(1_010_100)).toEqual({ epoch: 0, sourceTimeMs: 10_000 });
});
test('markerTime вычитает (embedLatency − captureLatency)', () => {
  ts.reportEmbedLatency(5000);
  expect(ts.markerTime(1_010_100)).toEqual({ epoch: 0, sourceTimeMs: 8_000 });
});
test.each([null, NaN, -1, 120_000])('задержка Embed %p → используется дефолт 4000', v => {
  ts.reportEmbedLatency(v as number); expect(ts.markerTime(1_010_100)!.sourceTimeMs).toBe(9_000);
});
test('Embed быстрее захвата (latency 1000) → время впереди captureNow, без отсечения', ...); // 12_000
test('результат не бывает отрицательным', ...);   // маркер в первую секунду эпохи → 0
test('markerOffsetMs прибавляется', ...);
test('новая эпоха использует только свои сегменты', ...);
test('до первого сегмента captureNow и markerTime возвращают null', ...);
```

- [ ] **Step 2: Запустить — падает.** Run: `npm test -- tests/main/capture/timeSync` → FAIL.
- [ ] **Step 3: Реализовать `TimeSynchronizer`.**
- [ ] **Step 4: Запустить — проходит.**
- [ ] **Step 5: Commit** — `feat: time synchronizer mapping wall clock to capture timeline`.

---

### Task 5: Процессы захвата и CaptureSessionManager

**Files:**
- Create: `src/main/capture/processes.ts`, `src/main/capture/sessionManager.ts`
- Test: `tests/main/capture/processes.test.ts`, `tests/main/capture/sessionManager.test.ts`

**Interfaces:**
- Consumes: `RingBufferManager`, `SegmentListTailer`, `TimeSynchronizer`, `Repos['sessions']`, `SettingsStore`.
- Produces (`processes.ts`):

```ts
normalizeChannel(input: string): string | null   // 'https://www.twitch.tv/Foo_Bar/' → 'foo_bar'; не [a-z0-9_]{1,25} → null
streamlinkArgs(channel: string, quality: string): string[]
ffmpegSegmentArgs(epochDir: string, segmentSeconds: number): string[]
interface CaptureProcs { onExit(cb: (reason: string) => void): void; stop(): Promise<void> }
interface ProcessRunner {
  probe(channel: string): Promise<{ live: true; streamId: string } | { live: false; reason: string }>;  // streamlink --json
  checkBinaries(): Promise<string | null>;                                                                // текст ошибки или null
  spawnCapture(channel: string, epochDir: string): CaptureProcs;
}
createProcessRunner(getSettings: () => Settings): ProcessRunner
```

Точные аргументы:
- `streamlinkArgs` → `['--stdout', '--twitch-low-latency', '--retry-streams', '0', 'https://twitch.tv/<channel>', <quality>]`
- `ffmpegSegmentArgs` → `['-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'segment', '-segment_time', '<segmentSeconds>', '-segment_format', 'mpegts', '-reset_timestamps', '0', '-segment_list', '<epochDir>/segments.csv', '-segment_list_type', 'csv', '<epochDir>/seg_%06d.ts']`
- `spawnCapture`: `streamlink.stdout.pipe(ffmpeg.stdin)`, `windowsHide: true`; `onExit` срабатывает один раз при выходе любого из двух процессов; `stop()` убивает streamlink, ждёт выхода ffmpeg до 5 с, затем убивает его.
- `probe`: JSON с `error` → `{ live: false, reason }`; `metadata.id` отсутствует → `streamId = 'unknown'`.

- Produces (`sessionManager.ts`):

```ts
class CaptureSessionManager extends EventEmitter {   // событие 'state' (CaptureSession | null)
  constructor(deps: { runner: ProcessRunner; ring: RingBufferManager; timeSync: TimeSynchronizer; sessions: Repos['sessions'];
                      settings: SettingsStore; beforeStop?: (session: CaptureSession) => Promise<void>;
                      sleep?: (ms: number) => Promise<void>; now?: () => number })
  current(): CaptureSession | null
  start(channel: string): Promise<void>
  stop(): Promise<void>
  reconnect(): Promise<void>
}
```

Поведение:
- `start`: если уже есть сессия — сначала `stop()`. `CONNECTING` → `checkBinaries` (ошибка → `ERROR` с текстом) → `normalizeChannel` (null → `ERROR` «Некорректное имя канала») → `probe` (не в эфире → `ERROR` «Канал не в эфире») → каталог `<bufferDir>/<sessionId>/e<epoch>` → `spawnCapture` + `SegmentListTailer`. Переход в `RECORDING` — по первому сегменту эпохи.
- Запись tailer → `Segment`: `startMs/endMs = round((sec − startSecПервогоСегментаЭпохи) × 1000)`, `completedAtWallMs = now()`, `bytes = fs.stat`; затем `ring.add`, `timeSync.onSegment`.
- Раз в 5 с и после каждого сегмента — `ring.cleanup()`.
- Неожиданный `onExit` → `RECONNECTING`, `epoch += 1`, повторы с паузами `2, 5, 10, 30, 30, …` с (без лимита, до `stop()`); каждый повтор = `probe` + `spawnCapture` в новом каталоге эпохи. Сегменты прошлых эпох не трогаются.
- `reconnect()` — принудительно то же самое немедленно.
- `stop`: `STOPPING` → `beforeStop(session)` (Task 7 собирает здесь авто-черновик) → `procs.stop()` → `ring.clearAll()` → `sessions.update(endedAt)` → `IDLE`, `current() === null`. Вызов `stop()` во время `stop()` или в `IDLE` — no-op.

- [ ] **Step 1: Написать падающие тесты**

```ts
// processes.test.ts
test.each([['Foo_Bar', 'foo_bar'], ['https://www.twitch.tv/Foo_Bar/', 'foo_bar'], ['twitch.tv/x?tt=1', 'x'], ['  shroud ', 'shroud']])('normalizeChannel(%j) = %j', ...);
test.each(['', 'a b', 'foo/bar/baz', 'имя', 'x'.repeat(26), '--help'])('normalizeChannel(%j) = null', ...);
test('ffmpegSegmentArgs: -c copy, segment_time 2, csv-список в каталоге эпохи', ...);
describe.skipIf(!hasFfmpeg)('ffmpeg', () => {
  test('реальный ffmpeg с ffmpegSegmentArgs режет mpegts из pipe на сегменты и пишет разбираемый csv', ...);
  // вход: `ffmpeg -f lavfi -i testsrc=d=6:r=30 -f lavfi -i sine=d=6 -g 30 -c:v libx264 -c:a aac -f mpegts pipe:1`;
  // ожидание: ≥ 2 файлов seg_*.ts, каждая строка csv проходит parseSegmentLine, endSec последней ∈ [5, 7]
});
// sessionManager.test.ts — FakeRunner (probe/spawnCapture управляются тестом, сегменты подкладываются записью строк в segments.csv), sleep — мгновенный
test('start: CONNECTING → RECORDING после первого сегмента; streamId из probe', ...);
test('канал не в эфире → ERROR с сообщением, процессы не запускаются', ...);
test('нет бинарников → ERROR с текстом checkBinaries', ...);
test('некорректное имя канала → ERROR, probe не вызывается', ...);
test('выход процесса → RECONNECTING, новая эпоха, после нового сегмента снова RECORDING', ...);
test('сегменты новой эпохи начинаются с startMs = 0 и лежат в отдельном каталоге', ...);
test('паузы повторов 2, 5, 10, 30, 30 секунд', ...);
test('stop во время RECONNECTING прекращает повторы и приводит к IDLE', ...);
test('stop вызывает beforeStop до остановки процессов и до очистки буфера', ...);
test('start второго канала останавливает первый: одновременно не более одного spawnCapture', ...);
```

- [ ] **Step 2: Запустить — падает.** Run: `npm test -- tests/main/capture/processes tests/main/capture/sessionManager` → FAIL.
- [ ] **Step 3: Реализовать `processes.ts`.**
- [ ] **Step 4: Реализовать `sessionManager.ts`.**
- [ ] **Step 5: Запустить — проходит.**
- [ ] **Step 6: Commit** — `feat: capture session manager with reconnect epochs`.

---

### Task 6: MomentService — маркеры и жизненный цикл момента

**Files:**
- Create: `src/main/moments/momentService.ts`
- Test: `tests/main/moments/momentService.test.ts`

**Interfaces:**
- Consumes: `Repos['moments'|'markers']`, `RingBufferManager.pin/unpin`, `TimeSynchronizer.markerTime`, `CaptureSessionManager.current()`, `SettingsStore`.
- Produces:

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
class MomentService extends EventEmitter {            // событие 'changed' (sessionId)
  constructor(deps: { repos: Repos; ring: RingBufferManager; timeSync: TimeSynchronizer; currentSession: () => CaptureSession | null; settings: SettingsStore; newId?: () => string })
  ensureActive(sessionId: string): Moment                         // создаёт ACTIVE-момент, если его нет
  addMarker(type: MarkerType, wallMs: number): Result<Marker>     // время фиксируется здесь
  setComment(markerId: string, comment: string): void             // trim, максимум 500 символов
  updateMarker(markerId: string, patch: { sourceTimeMs?: number; comment?: string; type?: MarkerType }): void  // перезакрепляет диапазон
  removeMarker(markerId: string): void                            // снимает pin
  beginExport(draft: Draft): Moment        // см. «Принятые решения» п.4; возвращает момент в статусе EXPORTING
  completeExport(momentId: string): void   // SAVED + unpin всех его маркеров
  failExport(momentId: string): void       // FAILED, pins остаются
  discardActive(sessionId: string): void   // маркеры удаляются, pins снимаются, момент DISCARDED, создаётся новый ACTIVE
}
```

`addMarker`: сессия отсутствует или не `RECORDING`, либо `markerTime` вернул `null` → `{ ok: false, error: 'Запись не идёт — маркер не поставлен' }`, в БД ничего не пишется. Иначе маркер сохраняется сразу с `comment: ''` и закрепляется `ring.pin(marker.id, epoch, t − pinBeforeMs, t + pinAfterMs)`.

`beginExport(draft)`: `M = moments.forDraft(draft.id)`. Если `M.status === 'FAILED'` → просто `EXPORTING` (повтор). Иначе: создать новый `ACTIVE`-момент `M'` той же сессии; маркеры `M` с `epoch !== draft.epoch` или `sourceTimeMs ∉ [draft.startMs, draft.endMs]` перенести в `M'` (pins не трогать); `M.draftId = draft.id`, `M.status = 'EXPORTING'`.

- [ ] **Step 1: Написать падающие тесты**

```ts
test('время маркера — от wallMs нажатия; setComment через 10 с его не меняет', ...);
test('повторное нажатие той же цифры создаёт второй маркер того же type', ...);
test('addMarker закрепляет [t − 30 000, t + 60 000] под id маркера', ...);
test.each(['IDLE→null', 'CONNECTING', 'RECONNECTING', 'RECORDING без сегментов'])('addMarker при %s → ok:false, маркер не создан', ...);
test('setComment("") допустим; комментарий длиннее 500 символов обрезается', ...);
test('updateMarker(sourceTimeMs) перезакрепляет диапазон', ...);
test('removeMarker снимает pin', ...);
test('beginExport: маркеры вне диапазона черновика и чужой эпохи переезжают в новый ACTIVE-момент с сохранением pins', ...);
test('маркер, добавленный после beginExport, попадает в новый момент и переживает completeExport', ...);
test('completeExport: SAVED и unpin; failExport: FAILED и pins на месте', ...);
test('beginExport по FAILED-моменту не создаёт ещё один ACTIVE и не переносит маркеры', ...);
test('discardActive удаляет маркеры, снимает pins и оставляет пустой ACTIVE-момент', ...);
```

- [ ] **Step 2: Запустить — падает.** Run: `npm test -- tests/main/moments/momentService` → FAIL.
- [ ] **Step 3: Реализовать `MomentService`.** Перенос маркеров и смена статусов в `beginExport` — в одной транзакции.
- [ ] **Step 4: Запустить — проходит.**
- [ ] **Step 5: Commit** — `feat: moment service with instant marker timestamps and export lifecycle`.

---

### Task 7: DraftService — F8, сборка и расширение черновика

**Files:**
- Create: `src/main/moments/draftService.ts`
- Modify: `src/main/capture/sessionManager.ts` (добавить `captureReplay(): Promise<string>`, делегирующий в инжектируемый `replay: () => Promise<string>` — сигнатура из спеки)
- Test: `tests/main/moments/draftService.test.ts`

**Interfaces:**
- Consumes: `RingBufferManager.select/latest/pin/unpin`, `TimeSynchronizer.captureNow`, `Repos['drafts'|'moments']`, `MomentService.ensureActive`, `SettingsStore`.
- Produces:

```ts
class DraftService extends EventEmitter {             // событие 'changed'
  constructor(deps: { repos: Repos; ring: RingBufferManager; timeSync: TimeSynchronizer; moments: MomentService; currentSession: () => CaptureSession | null;
                      settings: SettingsStore; draftsDir: string; concat?: (segments: string[], outFile: string) => Promise<void>;
                      sleep?: (ms: number) => Promise<void>; now?: () => number; newId?: () => string })
  captureReplay(): Promise<Result<Draft>>                                    // F8
  createFromMarkers(sessionId: string): Promise<Draft | null>                // авто-черновик при stop(); null, если маркеров нет или черновик уже есть
  extend(draftId: string, by: { beforeMs: number; afterMs: number }): Promise<Draft>   // возвращает фактический диапазон
  discard(draftId: string): Promise<void>                                    // файл, запись, pin; moments.draftId → null
  list(): Draft[]
}
concatSegments(ffmpegPath: string): (segments: string[], outFile: string) => Promise<void>
```

`captureReplay`: `T = captureNow(now())`; нет сессии в `RECORDING` или `T === null` → `{ ok:false, error:'Буфер пуст — нечего сохранять' }`. Сразу `ring.pin(draftId, epoch, T − replaySeconds·1000, T + replayTailSeconds·1000)`. Ждать, пока `ring.latest(epoch).endMs ≥ T + replayTailSeconds·1000`, опрос каждые 250 мс, не дольше 15 с (по таймауту — взять что есть). `segs = ring.select(...)`; пусто → unpin и `ok:false`. `concat(segs, <draftsDir>/<id>.mp4)`; `Draft.startMs = segs[0].startMs`, `endMs = segs.at(-1).endMs`; `moments.setDraft(activeMoment.id, draft.id)`. Ошибка concat → unpin, файл удалить, `ok:false` с текстом. Параллельные вызовы независимы (каждый — свой черновик).

`createFromMarkers`: берёт эпоху последнего по времени маркера активного момента, диапазон `[min(t) − pinBeforeMs, max(t) + pinAfterMs]` по маркерам этой эпохи.

`extend`: новый диапазон `[startMs − beforeMs, endMs + afterMs]` → `ring.pin(draftId, …)` → `select` → concat во временный файл → атомарная замена → обновить `startMs/endMs` по фактическим сегментам. Если сегментов за пределами текущего диапазона нет (или сессия уже остановлена) — вернуть черновик без изменений.

`concatSegments`: файл-список `file '<abs>'` (одинарные кавычки в пути экранировать как `'\''`), команда `ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i <list> -c copy -movflags +faststart -y <out>`.

- [ ] **Step 1: Написать падающие тесты** (ring наполняется синтетическими сегментами, `concat` — заглушка, записывающая список в файл)

```ts
test('F8 берёт сегменты, пересекающие [T − 180 с, T + 5 с], и ждёт дозаписи 5 с', ...); // сегменты до T+5с добавляются во время sleep
test('диапазон черновика — по фактическим границам сегментов', ...);
test('буфер короче 180 с → черновик из имеющегося', ...);
test.each(['нет сессии', 'RECONNECTING', 'RECORDING без сегментов'])('F8 при %s → ok:false, pin снят, файла нет', ...);
test('дозапись не пришла за 15 с → черновик из того, что есть', ...);
test('два F8 подряд → два независимых черновика; draftId активного момента = последний', ...);
test('сегменты черновика не удаляются cleanup-ом, пока черновик жив', ...);
test('ошибка concat → ok:false, pin снят, частичный файл удалён', ...);
test('createFromMarkers: диапазон [min − 30 с, max + 60 с] в эпохе последнего маркера; null без маркеров', ...);
test('extend расширяет диапазон, пока сегменты есть; без сегментов возвращает прежний черновик', ...);
test('discard удаляет файл, запись и pin, обнуляет draftId момента', ...);
describe.skipIf(!hasFfmpeg)('concatSegments', () => {
  test('склеивает 3 реальных ts-сегмента в mp4 длительностью ≈ сумме (±0.5 с)', ...); // длительность через `ffmpeg -i` / ffprobe
  test('путь с пробелом и апострофом', ...);
});
```

- [ ] **Step 2: Запустить — падает.** Run: `npm test -- tests/main/moments/draftService` → FAIL.
- [ ] **Step 3: Реализовать `DraftService` и `concatSegments`; добавить `captureReplay` в `CaptureSessionManager`** (возвращает `draft.id`, при `ok:false` бросает `Error(error)`).
- [ ] **Step 4: Запустить — проходит.**
- [ ] **Step 5: Commit** — `feat: replay drafts from ring buffer (F8), extend and discard`.

---

### Task 8: Очередь задач, пути и экспорт клипа

**Files:**
- Create: `src/main/jobs/jobQueue.ts`, `src/main/export/paths.ts`, `src/main/export/exporter.ts`
- Test: `tests/main/jobs/jobQueue.test.ts`, `tests/main/export/paths.test.ts`, `tests/main/export/exporter.test.ts`

**Interfaces:**
- Consumes: `Repos`, `MomentService.beginExport/completeExport/failExport`, `DraftService.discard`, `toClipMarkers`, `SettingsStore`.
- Produces:

```ts
// jobQueue.ts
type JobType = 'export' | 'sync';
class JobQueue<P> {
  constructor(db: Database, type: JobType, handler: (payload: P) => Promise<void>,
              opts: { maxAttempts: number; backoffMs: (attempt: number) => number; onFailed?: (payload: P, error: string) => void; now?: () => number })
  enqueue(payload: P, dedupeKey?: string): string     // при наличии queued/running задачи с тем же dedupeKey возвращает её id
  recover(): void                                     // running → queued (вызывать при старте)
  tick(): Promise<boolean>                            // выполняет одну готовую задачу; false, если готовых нет
  start(intervalMs?: number): void                    // цикл tick, по умолчанию 1000 мс
  stop(): Promise<void>                               // ждёт текущую задачу
  retryFailed(): number                               // failed → queued, attempts = 0
}
// paths.ts
slugify(title: string): string
sessionFolderName(streamId: string, startedAt: Date): string   // '987654321_2026-11-14_18-30' (локальное время)
clipFolderName(createdAt: Date, slug: string, clipId: string): string   // '2026-11-14_19-42_funny-reaction_a42f' — последние 4 hex-символа id
clipPaths(libraryDir: string, session: CaptureSession, createdAt: Date, title: string, clipId: string): { dir: string; mp4Path: string; markersPath: string; slug: string }
// exporter.ts
interface ExportJob { momentId: string; draftId: string; trimStartMs: number; trimEndMs: number; title: string; clipId: string }
class Exporter extends EventEmitter {                 // события 'saved' (Clip), 'failed' ({ momentId, error })
  constructor(deps: { repos: Repos; moments: MomentService; drafts: DraftService; settings: SettingsStore;
                      encode?: (a: { input: string; startMs: number; durationMs: number; output: string }) => Promise<void>; now?: () => Date })
  request(req: ExportRequest): Result<ExportJob>      // синхронно: валидация + moments.beginExport; результат кладётся в очередь вызывающим кодом
  handle(job: ExportJob): Promise<void>               // обработчик очереди 'export'
  onFailed(job: ExportJob, error: string): void       // moments.failExport + событие
}
encodeClip(ffmpegPath: string): Exporter['deps']['encode']
```

Правила:
- `slugify`: NFC; нижний регистр; пробелы и `_` → `-`; оставить буквы и цифры Unicode (`\p{L}\p{N}`) и `-`; схлопнуть повторы `-`; убрать `-` и `.` по краям; обрезать до 60 символов; пусто → `clip`; зарезервированные имена Windows (`con, prn, aux, nul, com1-9, lpt1-9`) → с префиксом `clip-`.
- `request`: черновик не найден → `ok:false`; `trimStartMs` и `trimEndMs` приводятся к `[0, draft.endMs − draft.startMs]`; `trimEndMs − trimStartMs < 500` → `ok:false, error:'Клип короче 0,5 секунды'`.
- `handle`: `mkdir -p dir` → `encode` во `<slug>.mp4.part` → rename в `<slug>.mp4` → `markers.json` через `.part` + rename → `clips.insert` (`syncStatus: 'pending'`) → `moments.completeExport` → `drafts.discard(draftId)` → событие `saved`. При ошибке на любом шаге `.part`-файлы удаляются, ошибка пробрасывается (очередь вызовет `onFailed`).
- `encodeClip`: `ffmpeg -hide_banner -loglevel error -ss <startSec> -i <input> -t <durSec> -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 160k -movflags +faststart -f mp4 -y <output>`, секунды с тремя знаками.
- Очередь `export`: `maxAttempts: 1`. Очередь `sync` (Task 12): `maxAttempts: 5`, `backoffMs = n => 30_000 * 2 ** (n − 1)`.

`markers.json`:

```json
{ "version": 1, "clipId": "…", "title": "Funny reaction", "streamer": "streamer_name", "streamId": "987654321",
  "createdAt": "2026-11-14T19:42:10.000Z", "durationMs": 42000, "sourceEpoch": 0, "sourceStartMs": 100000,
  "markers": [ { "id": "…", "type": 2, "timeMs": 30000, "comment": "…" } ] }
```

- [ ] **Step 1: Написать падающие тесты**

```ts
// paths.test.ts
test.each([
  ['Funny reaction', 'funny-reaction'], ['  Смешной   момент!! ', 'смешной-момент'], ['a<b>:c"/\\|?*d', 'abcd'],
  ['', 'clip'], ['???', 'clip'], ['CON', 'clip-con'], ['nul', 'clip-nul'], ['name. ', 'name'], ['a__b--c', 'a-b-c'],
])('slugify(%j) = %j', ...);
test('slugify обрезает до 60 символов и не оставляет дефис на конце', ...);
test('раскладка из спеки', () => {
  const p = clipPaths('D:/TwitchHighlights', { streamer: 'streamer_name', streamId: '987654321', startedAt: local(2026, 11, 14, 18, 30) }, local(2026, 11, 14, 19, 42), 'Funny reaction', 'c0ffeea42f');
  expect(rel(p.mp4Path)).toBe('streamer_name/987654321_2026-11-14_18-30/2026-11-14_19-42_funny-reaction_a42f/funny-reaction.mp4');
  expect(path.basename(p.markersPath)).toBe('markers.json');
});
// jobQueue.test.ts
test('задачи выполняются по одной в порядке постановки', ...);
test('ошибка → повтор не раньше backoffMs(attempt); после maxAttempts → failed и onFailed с текстом ошибки', ...);
test('recover возвращает running в queued (выход приложения посреди задачи)', ...);
test('dedupeKey не даёт поставить вторую такую же задачу, пока первая queued/running', ...);
test('retryFailed возвращает failed-задачи в очередь с attempts = 0', ...);
test('очереди разных type не видят задачи друг друга', ...);
test('stop дожидается выполняемой задачи', ...);
// exporter.test.ts (encode — заглушка, создающая файл)
test('успех: mp4 и markers.json на месте, .part нет, clip в БД, момент SAVED, черновик удалён', ...);
test('markers.json: timeMs = sourceTimeMs − draft.startMs − trimStartMs; маркеры вне trim отсутствуют', ...);
test('клип без маркеров сохраняется с "markers": []', ...);
test('ошибка encode: момент FAILED (через onFailed), черновик и маркеры целы, в папке клипа нет .part', ...);
test('request: trim за пределами черновика приводится к границам; длительность < 500 мс → ok:false и момент остаётся ACTIVE', ...);
test('два клипа с одинаковым названием в одну минуту лежат в разных папках', ...);
describe.skipIf(!hasFfmpeg)('encodeClip', () => {
  test('вырезает [2 с, 5 с] из 10-секундного mp4 → длительность 3 с ± 0.1', ...);
});
```

- [ ] **Step 2: Запустить — падает.** Run: `npm test -- tests/main/jobs tests/main/export` → FAIL.
- [ ] **Step 3: Реализовать `jobQueue.ts`.**
- [ ] **Step 4: Реализовать `paths.ts`.**
- [ ] **Step 5: Реализовать `exporter.ts`.**
- [ ] **Step 6: Запустить — проходит.**
- [ ] **Step 7: Commit** — `feat: job queue, clip paths and exporter`.

---

### Task 9: Локальный сервер, хоткеи, IPC и сборка main-процесса

**Files:**
- Create: `src/main/server.ts`, `src/main/hotkeys.ts`, `src/main/ipc.ts`
- Modify: `src/main/index.ts`, `src/preload/index.ts`, `src/shared/types.ts` (добавить `ThrApi`, `ThrEvents`)
- Test: `tests/main/server.test.ts`, `tests/main/hotkeys.test.ts`

**Interfaces:**
- Consumes: все сервисы из Task 2–8.
- Produces:

```ts
// server.ts
startLocalServer(opts: { rendererDir: string; draftsDir: string }): Promise<{ port: number; origin: string; close(): Promise<void> }>
// слушает 127.0.0.1:0; origin = `http://localhost:${port}`
// GET /media/drafts/<id>.mp4 — id строго /^[A-Za-z0-9_-]+$/; поддержка Range (206, Content-Range, Accept-Ranges); 404 если нет
// остальное — статика из rendererDir, неизвестный путь без расширения → index.html; выход за rendererDir → 403

// hotkeys.ts
type HotkeyAction = { kind: 'marker'; type: MarkerType } | { kind: 'replay' } | { kind: 'toggleEditor' } | { kind: 'save' };
interface KeyInput { type: 'keyDown' | 'keyUp'; code: string; control: boolean; alt: boolean; shift: boolean; meta: boolean; isAutoRepeat: boolean }
resolveHotkey(input: KeyInput, ui: UiState): HotkeyAction | null
attachHotkeys(webContents: WebContents, getUi: () => UiState, onAction: (a: HotkeyAction, wallMs: number) => void): void
// before-input-event: wallMs = Date.now() берётся первым делом; при действии — event.preventDefault()

// types.ts
interface ThrApi {
  capture: { start(channel: string): Promise<void>; stop(): Promise<void>; status(): Promise<CaptureStatus> };
  player:  { reportLatency(ms: number | null): void };
  ui:      { setState(s: UiState): void };
  markers: { setComment(id: string, comment: string): Promise<void>; update(id: string, patch: { sourceTimeMs?: number; comment?: string; type?: MarkerType }): Promise<void>; remove(id: string): Promise<void> };
  moment:  { active(): Promise<Moment | null>; discardActive(): Promise<void> };
  drafts:  { list(): Promise<Draft[]>; open(id: string | null): Promise<{ draft: Draft; moment: Moment; mediaUrl: string } | null>;
             extend(id: string, by: { beforeMs: number; afterMs: number }): Promise<Draft>; discard(id: string): Promise<void> };
  clips:   { export(req: ExportRequest): Promise<Result<{ clipId: string }>>; list(): Promise<Clip[]>; failed(): Promise<Moment[]>;
             showInFolder(id: string): Promise<void>; sync(id: string): Promise<void>; syncAll(): Promise<void> };
  drive:   { status(): Promise<{ connected: boolean; email?: string }>; connect(): Promise<Result<null>>; disconnect(): Promise<void> };
  settings:{ get(): Promise<Settings>; set(patch: Partial<Settings>): Promise<Settings> };
  on<K extends keyof ThrEvents>(event: K, cb: (payload: ThrEvents[K]) => void): () => void;
}
interface ThrEvents {
  'capture:status': CaptureStatus; 'marker:prompt': Marker; 'moment:changed': Moment | null; 'drafts:changed': null; 'clips:changed': null;
  'nav': { view: 'watch' | 'editor'; draftId?: string }; 'editor:save': null; 'notice': Notice;
}
```

Правила `resolveHotkey` (только `keyDown`, `isAutoRepeat === false`, `meta === false`):
- `Digit1…Digit9` / `Numpad1…Numpad9` без `control/alt/shift`, `ui.mode === 'watch'`, `!ui.textInputFocused` → `marker`.
- `F8` без модификаторов, `mode ∈ {watch, editor}` → `replay`.
- `F9` без модификаторов, `mode ∈ {watch, editor}` → `toggleEditor`.
- `KeyS` + `control`, без `alt/shift`, `mode === 'editor'` (независимо от `textInputFocused`) → `save`.
- иначе `null`.

Обработка действий в `index.ts`:
- `marker` → `moments.addMarker(type, wallMs)`; `ok` → событие `marker:prompt`; иначе `notice` (warn) с текстом ошибки.
- `replay` → `notice` «Сохраняю повтор…» → `drafts.captureReplay()` → `notice` «Черновик сохранён» / текст ошибки.
- `toggleEditor` → из `watch`: `nav { view: 'editor', draftId: активныйМомент.draftId }` (если черновика нет — сначала `captureReplay()`, при ошибке только `notice`); из `editor`: `nav { view: 'watch' }`.
- `save` → событие `editor:save` (renderer отвечает вызовом `clips.export` со своим trim и названием).

`drafts.open(null)` открывает черновик активного момента. `clips.export` = `exporter.request` → `exportQueue.enqueue(job)` → `{ clipId }`.

Сборка в `index.ts`: `app.requestSingleInstanceLock()`; `openDb(<userData>/thr.sqlite)`; `ring.clearAll()` и удаление содержимого `bufferDir`; `ACTIVE`-моменты прошлых сессий без черновика → `DISCARDED` (сегментов для них уже нет; штатный `stop()` всегда собирает черновик, так что сюда попадают только пустые моменты и последствия аварийного завершения); `EXPORTING`-моменты → остаются, их задачи вернёт `exportQueue.recover()`; `exportQueue.recover()/start()`; `sessionManager` с `beforeStop: s => drafts.createFromMarkers(s.id)`; `exporter.on('saved')` → `clips:changed` + (Task 12) постановка sync; `ring.on('pinLimit')` → `notice` (warn) «Временное хранилище превысило лимит — сохраните или удалите черновики». Окно: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; URL — `process.env.ELECTRON_RENDERER_URL ?? server.origin`; `setWindowOpenHandler` → `shell.openExternal` + deny. `capture:status` рассылается раз в 1 с и по событию `state`. `before-quit`: `preventDefault` → `sessionManager.stop()` → `queues.stop()` → `app.exit()`.

- [ ] **Step 1: Написать падающие тесты**

```ts
// hotkeys.test.ts
const key = (code: string, o: Partial<KeyInput> = {}): KeyInput => ({ type: 'keyDown', code, control: false, alt: false, shift: false, meta: false, isAutoRepeat: false, ...o });
const watch: UiState = { mode: 'watch', textInputFocused: false };
test.each([1,2,3,4,5,6,7,8,9])('Digit%i в режиме просмотра → marker', n => expect(resolveHotkey(key(`Digit${n}`), watch)).toEqual({ kind: 'marker', type: n }));
test('Numpad5 → marker 5', ...);
test.each([
  ['ввод текста', key('Digit2'), { mode: 'watch', textInputFocused: true }],
  ['редактор', key('Digit2'), { mode: 'editor', textInputFocused: false }],
  ['другой экран', key('Digit2'), { mode: 'other', textInputFocused: false }],
  ['Ctrl+2', key('Digit2', { control: true }), watch], ['Alt+2', key('Digit2', { alt: true }), watch], ['Shift+2', key('Digit2', { shift: true }), watch],
  ['auto-repeat', key('Digit2', { isAutoRepeat: true }), watch], ['keyUp', key('Digit2', { type: 'keyUp' }), watch], ['Digit0', key('Digit0'), watch],
])('%s → null', (_n, input, ui) => expect(resolveHotkey(input, ui as UiState)).toBeNull());
test('F8 и F9 работают в watch и editor, не работают в other', ...);
test('Ctrl+S → save только в редакторе, в том числе при фокусе в поле названия', ...);
// server.test.ts
test('GET / отдаёт index.html; неизвестный путь без расширения — тоже', ...);
test('GET /media/drafts/<id>.mp4 с Range: bytes=10-19 → 206, 10 байт, корректный Content-Range', ...);
test('без Range → 200 и Accept-Ranges: bytes', ...);
test.each(['/media/drafts/..%2F..%2Fthr.sqlite.mp4', '/media/drafts/a%00b.mp4', '/..%2Fsecret.txt'])('обход каталога %s → 403/404, файл не отдаётся', ...);
test('сервер слушает только 127.0.0.1', ...);
```

- [ ] **Step 2: Запустить — падает.** Run: `npm test -- tests/main/hotkeys tests/main/server` → FAIL.
- [ ] **Step 3: Реализовать `hotkeys.ts` и `server.ts`.**
- [ ] **Step 4: Запустить — проходит.**
- [ ] **Step 5: Добавить `ThrApi`/`ThrEvents` в `types.ts`; реализовать `ipc.ts` (`ipcMain.handle('thr:<группа>.<метод>')`), `preload/index.ts` (`contextBridge.exposeInMainWorld('thr', …)` строго по `ThrApi`) и сборку в `index.ts`.** Обработчики IPC отклоняют вызовы, у которых `event.senderFrame !== mainWindow.webContents.mainFrame`.
- [ ] **Step 6: Проверить вручную.** Run: `npm run dev`, в DevTools: `await thr.settings.get()` → объект с `bufferSeconds: 300`; `await thr.capture.status()` → `{ session: null, bufferedMs: 0, … }`. Run: `npm test` → PASS целиком.
- [ ] **Step 7: Commit** — `feat: local server, hotkey routing, ipc contract and main wiring`.

---

### Task 10: Экран просмотра — Twitch Embed, статус, поле комментария

**Files:**
- Create: `src/renderer/src/store.ts`, `src/renderer/src/views/WatchView.tsx`, `src/renderer/src/components/{TwitchPlayer,MarkerPrompt,StatusBar,Notices}.tsx`, `src/renderer/src/styles.css`
- Modify: `src/renderer/src/App.tsx`, `src/renderer/index.html`
- Test: `tests/renderer/MarkerPrompt.test.tsx` (добавить dev-зависимости `@testing-library/react`, `jsdom`; в файле — `// @vitest-environment jsdom`; `include` в `vitest.config.ts` расширить на `*.test.tsx`)

**Interfaces:**
- Consumes: `window.thr: ThrApi`, события `ThrEvents`, `formatTimecode`.
- Produces:
  - `<TwitchPlayer channel={string} onLatency={(ms: number | null) => void} />`
  - `<MarkerPrompt marker={Marker | null} onSubmit={(id: string, comment: string) => void} onCancel={(id: string) => void} />`
  - `useAppStore()` (React context + `useReducer`): `{ view: 'watch'|'editor'|'library'|'settings'; editorDraftId: string | null; status: CaptureStatus; moment: Moment | null; notices: Notice[] }`.

Поведение:
- `App` подписывается на все `ThrEvents`; на каждое изменение `view` и на `focusin/focusout` вызывает `thr.ui.setState({ mode, textInputFocused })`, где `mode = view === 'watch' ? 'watch' : view === 'editor' ? 'editor' : 'other'`, `textInputFocused` — `document.activeElement` это `input`, `textarea` или `[contenteditable]`.
- `TwitchPlayer`: подгружает `https://player.twitch.tv/js/embed/v1.js` один раз; `new Twitch.Player(el, { channel, parent: ['localhost'], width: '100%', height: '100%', autoplay: true, muted: false })`; раз в 1 с `onLatency(round(player.getPlaybackStats()?.hlsLatencyBroadcaster × 1000))`, при исключении/нечисловом значении — `onLatency(null)`; при смене `channel` — `player.setChannel`. Когда фокус уходит в iframe плеера (`window` получает `blur`, а `document.activeElement` — iframe), через `setTimeout(0)` вернуть фокус окну (`window.focus()`), чтобы `textInputFocused` оставался достоверным.
- `WatchView`: поле «Канал» + кнопки «Смотреть»/«Стоп» (`thr.capture.start/stop`, канал сохраняется в `settings.lastChannel`); плеер; `StatusBar`: бейдж состояния (`LIVE` для `RECORDING`; «Подключение…», «Переподключение…», текст ошибки для `ERROR`), ник, «Буфер mm:ss» (`bufferedMs`, максимум 05:00), «N маркеров», подсказка `1-9 · F8 · F9`.
- `MarkerPrompt` поверх плеера, плеер не перекрывается целиком и не останавливается: заголовок «Новый маркер», цифра типа, `formatTimecode(marker.sourceTimeMs)`, поле с плейсхолдером «Комментарий к моменту…» (автофокус), подсказка «Enter — сохранить без комментария». `Enter` → `onSubmit(id, text)`; `Esc` → `onCancel(id)` (маркер удаляется через `thr.markers.remove`). Новый `marker:prompt` при открытом поле: текущий текст сохраняется как комментарий предыдущего маркера, поле переключается на новый.
- `Notices`: стек тостов, `info` исчезает через 4 с, `warn/error` — через 8 с.

- [ ] **Step 1: Написать падающий тест `MarkerPrompt.test.tsx`**

```tsx
test('показывает тип, таймкод 02:31.420 и фокусирует поле', ...);     // marker.sourceTimeMs = 151_420, type 2
test('Enter с пустым полем → onSubmit(id, "")', ...);
test('Enter с текстом → onSubmit(id, "текст")', ...);
test('Esc → onCancel(id), onSubmit не вызывается', ...);
test('цифры, набранные в поле, попадают в текст комментария', ...);
test('смена marker при непустом поле → onSubmit(старыйId, набранныйТекст), поле очищено для нового', ...);
```

- [ ] **Step 2: Запустить — падает.** Run: `npm test -- tests/renderer` → FAIL.
- [ ] **Step 3: Реализовать `store.ts`, `Notices`, `MarkerPrompt`.**
- [ ] **Step 4: Запустить — проходит.**
- [ ] **Step 5: Реализовать `TwitchPlayer`, `StatusBar`, `WatchView`, навигацию в `App` (вкладки «Просмотр», «Библиотека», «Настройки»; редактор открывается по `nav`).**
- [ ] **Step 6: Проверить вручную на живом канале (нужны `streamlink` и `ffmpeg` в PATH).** Run: `npm run dev`. Ожидается: Embed показывает эфир без ошибки `parent`; через ~5–10 с статус `LIVE`, счётчик буфера растёт до 05:00 и останавливается; клик по плееру, затем `2` → поле комментария с таймкодом; `Enter` → «1 маркер»; цифры в поле комментария не создают маркеры; `F8` → через ~5 с тост «Черновик сохранён».
- [ ] **Step 7: Commit** — `feat: watch view with Twitch embed, status bar and marker prompt`.

---

### Task 11: Редактор, библиотека и настройки

**Files:**
- Create: `src/renderer/src/views/{EditorView,LibraryView,SettingsView}.tsx`, `src/renderer/src/components/Timeline.tsx`, `src/renderer/src/timelineMath.ts`
- Test: `tests/renderer/timelineMath.test.ts`

**Interfaces:**
- Consumes: `thr.drafts.open/extend/discard`, `thr.markers.*`, `thr.clips.*`, `thr.drive.*`, `thr.settings.*`, события `editor:save`, `nav`, `moment:changed`, `clips:changed`, `drafts:changed`.
- Produces (`timelineMath.ts`):
  - `pxToMs(px: number, widthPx: number, durationMs: number): number` — с приведением к `[0, durationMs]`, округление до мс
  - `msToPx(ms: number, widthPx: number, durationMs: number): number`
  - `clampTrim(startMs: number, endMs: number, durationMs: number, minMs = 500): { startMs: number; endMs: number }` — начало не позже `end − minMs`, оба в границах
  - `<Timeline durationMs trim markers currentMs onTrim onMarkerMove onSeek onMarkerSelect />`

Поведение `EditorView` (`draftId` из стора; `thr.drafts.open(draftId)`, `null` → сообщение «Черновиков нет — нажмите F8 во время просмотра»):
- `<video src={mediaUrl}>` с кнопками play/pause, шаг ±1 кадр (1/30 с) и ±1 с; воспроизведение зацикливается внутри trim.
- `Timeline`: две ручки trim (начальные значения — весь черновик), метки маркеров с цифрой типа (перетаскивание → `thr.markers.update(id, { sourceTimeMs: draft.startMs + ms })` по отпусканию), клик по дорожке — seek. Маркеры момента вне диапазона черновика показываются в списке серым с пометкой «вне черновика» и не перетаскиваются.
- Список маркеров: тип (select 1–9), таймкод относительно начала клипа (`formatTimecode(t − draft.startMs − trim.startMs)`, вне trim — «не войдёт в клип»), комментарий (правка по blur/Enter), «Удалить», клик — seek.
- Поле «Название клипа» (по умолчанию — комментарий первого маркера, иначе пусто); кнопки «−30 с» / «+30 с» (`thr.drafts.extend`, после ответа перезагрузить `mediaUrl` с cache-buster `?v=<endMs>-<startMs>`; trim сохраняет абсолютное положение в источнике); «Удалить черновик» (confirm); «Сохранить (Ctrl+S)».
- `editor:save` или кнопка → `thr.clips.export({ draftId, trimStartMs, trimEndMs, title })`; `ok` → тост «Клип сохраняется…», переход на «Просмотр»; иначе тост с ошибкой, редактор остаётся открытым. Повторное `editor:save`, пока запрос не вернулся, игнорируется.

`LibraryView`: три секции — «Черновики» (`thr.drafts.list`, открыть/удалить), «Не сохранены» (`thr.clips.failed`, «Открыть в редакторе» по `moment.draftId`), «Клипы» (`thr.clips.list`: название, дата, длительность, статус синхронизации «Ожидает / В облаке / Ошибка», кнопки «Показать в папке», «Синхронизировать») и общая кнопка «Синхронизировать всё».

`SettingsView`: `libraryDir`, пути к `streamlink`/`ffmpeg`, `quality`, `captureLatencyMs`, `defaultEmbedLatencyMs`, `markerOffsetMs`, блок Google Drive (Client ID, Client Secret, статус, «Подключить»/«Отключить», флажок «Синхронизировать автоматически»). Числовые поля принимают только целые в пределах `[-60000, 60000]`.

- [ ] **Step 1: Написать падающий тест `timelineMath.test.ts`**

```ts
test('pxToMs/msToPx взаимно обратны в пределах 1 px', ...);
test('pxToMs приводит к [0, durationMs] при px < 0 и px > width', ...);
test('pxToMs при widthPx = 0 возвращает 0', ...);
test('clampTrim: start ≥ end → start = end − 500', () => expect(clampTrim(9_000, 8_000, 10_000)).toEqual({ startMs: 7_500, endMs: 8_000 }));
test('clampTrim: выход за границы и черновик короче 500 мс', () => {
  expect(clampTrim(-5, 20_000, 10_000)).toEqual({ startMs: 0, endMs: 10_000 });
  expect(clampTrim(0, 300, 300)).toEqual({ startMs: 0, endMs: 300 });
});
```

- [ ] **Step 2: Запустить — падает.** Run: `npm test -- tests/renderer/timelineMath` → FAIL.
- [ ] **Step 3: Реализовать `timelineMath.ts` и `Timeline.tsx`** (pointer events + `setPointerCapture`).
- [ ] **Step 4: Запустить — проходит.**
- [ ] **Step 5: Реализовать `EditorView`, `LibraryView`, `SettingsView`.**
- [ ] **Step 6: Проверить вручную.** Run: `npm run dev`; на живом канале: два маркера → `F9` → редактор с превью и двумя метками; сдвинуть ручки trim, перетащить маркер, изменить комментарий, ввести название «Funny reaction» → `Ctrl+S`. Ожидается: возврат к просмотру, «0 маркеров»; через несколько секунд в `%USERPROFILE%\Videos\TwitchHighlights\<канал>\<streamId>_<дата>\<дата>_funny-reaction_<xxxx>\` лежат `funny-reaction.mp4` и `markers.json`; таймкоды в `markers.json` совпадают с положением меток в редакторе; маркер, поставленный сразу после `Ctrl+S`, остаётся в счётчике после завершения экспорта.
- [ ] **Step 7: Commit** — `feat: clip editor with trim and marker editing, library and settings views`.

---

### Task 12: Google Drive — авторизация и фоновая синхронизация

**Files:**
- Create: `src/main/drive/auth.ts`, `src/main/drive/driveClient.ts`, `src/main/drive/syncWorker.ts`
- Modify: `src/main/index.ts`, `src/main/ipc.ts` (подключить `drive.*`, `clips.sync`, `clips.syncAll`)
- Test: `tests/main/drive/syncWorker.test.ts`

**Interfaces:**
- Consumes: `JobQueue<{ clipId: string }>` типа `sync`, `Repos['clips'|'driveFiles'|'sessions']`, `SettingsStore`, `safeStorage`, `shell.openExternal`.
- Produces:

```ts
// auth.ts
class DriveAuth {
  constructor(deps: { settings: SettingsStore; tokenFile: string; encrypt(s: string): Buffer; decrypt(b: Buffer): string; openExternal(url: string): Promise<void> })
  status(): Promise<{ connected: boolean; email?: string }>
  connect(): Promise<Result<null>>        // loopback http://127.0.0.1:<свободный порт>/oauth2callback, PKCE (S256), state, access_type=offline, prompt=consent; таймаут 5 минут
  disconnect(): Promise<void>             // revoke + удаление tokenFile
  client(): Promise<OAuth2Client | null>  // null, если не подключено; обновлённые токены перезаписываются в tokenFile
}
// scope: 'https://www.googleapis.com/auth/drive.file' и 'openid email'
// driveClient.ts
interface DriveClient {
  ensureFolder(name: string, parentId: string | null): Promise<string>;   // files.list по name + parent + mimeType папки + trashed=false; создать, только если нет
  uploadFile(a: { localPath: string; name: string; parentId: string; mimeType: string; existingFileId?: string }): Promise<{ id: string; version: string; md5: string }>;
}
createDriveClient(auth: OAuth2Client): DriveClient   // resumable upload потоком; existingFileId → files.update; 404 на update → создать заново
// syncWorker.ts
class SyncWorker {
  constructor(deps: { repos: Repos; getClient: () => Promise<DriveClient | null>; md5File?: (p: string) => Promise<string> })
  handle(job: { clipId: string }): Promise<void>
  onFailed(job: { clipId: string }, error: string): void      // clips.setSyncStatus('failed')
}
```

`handle`: клип не найден → выйти без ошибки. Любого из двух файлов нет на диске → `throw Error('Файлы клипа не готовы')`. `getClient() === null` → `throw Error('Google Drive не подключён')`. Цепочка папок `TwitchHighlights / <streamer> / <папка сессии> / <папка клипа>` (имена — из локального пути клипа относительно `libraryDir`); id папок кэшируются в `drive_folders` по `pathKey` (относительный путь через `/`). Затем `mp4` (`video/mp4`), затем `markers` (`application/json`): если есть строка `drive_files` и её `md5` равен локальному — файл пропускается; иначе `uploadFile` (с `existingFileId`, если строка есть) и `upsert`. После обоих — `clips.setSyncStatus('synced')`.

Подключение в `index.ts`: очередь `sync` с `maxAttempts: 5`, `backoffMs = n => 30_000 * 2 ** (n − 1)`, `dedupeKey = clipId`; `exporter.on('saved')` → если `driveAutoSync` и Drive подключён → `enqueue`; `clips.sync(id)` → `enqueue` всегда; `clips.syncAll()` → `retryFailed()` + `enqueue` для всех клипов со статусом не `synced`; после успешного `drive.connect()` → то же, что `syncAll`. При старте — `syncQueue.recover()`.

- [ ] **Step 1: Написать падающий тест `syncWorker.test.ts`** (FakeDriveClient хранит дерево в памяти и считает вызовы)

```ts
test('создаёт цепочку TwitchHighlights/streamer/сессия/клип и загружает mp4, затем markers.json; клип → synced', ...);
test('повторная синхронизация без изменений ничего не загружает и не создаёт папок', ...);
test('изменённый markers.json обновляется по existingFileId, mp4 не трогается', ...);
test('второй клип той же сессии переиспользует папки стримера и сессии', ...);
test('сбой после загрузки mp4 → ошибка; повтор загружает только markers.json, дубликата mp4 нет', ...);
test('нет одного из файлов → ошибка «Файлы клипа не готовы», в Drive ничего не создано', ...);
test('Drive не подключён → ошибка, статус клипа не synced', ...);
test('ошибка сети в uploadFile пробрасывается (очередь сделает backoff); onFailed ставит статус failed', ...);
test('удалённый клип → задача завершается без ошибки', ...);
```

- [ ] **Step 2: Запустить — падает.** Run: `npm test -- tests/main/drive` → FAIL.
- [ ] **Step 3: Реализовать `SyncWorker`.**
- [ ] **Step 4: Запустить — проходит.**
- [ ] **Step 5: Реализовать `DriveAuth` и `createDriveClient`, подключить в `index.ts`/`ipc.ts`.** Токены и Client Secret не попадают в логи и тексты `Notice`.
- [ ] **Step 6: Проверить вручную.** В Google Cloud Console создать OAuth-клиент типа Desktop, включить Drive API, ввести Client ID/Secret в «Настройках» → «Подключить» → в браузере выдать доступ → статус «Подключено: <email>». Сохранить клип → через несколько секунд в Drive `TwitchHighlights/<канал>/<сессия>/<клип>/` с двумя файлами, статус «В облаке». Отключить сеть, сохранить клип → «Ожидает»; включить сеть → загрузка проходит сама в течение ~1 минуты. «Синхронизировать всё» повторно → дубликатов в Drive нет.
- [ ] **Step 7: Commit** — `feat: google drive auth and background sync worker`.

---

### Task 13: Сборка под Windows и сквозная проверка

**Files:**
- Create: `electron-builder.yml`, `README.md`, `docs/smoke-checklist.md`

**Interfaces:**
- Consumes: всё приложение.
- Produces: `dist/Twitch Highlight Recorder Setup <version>.exe`.

- [ ] **Step 1: Написать `electron-builder.yml`.** `appId: local.twitch-highlight-recorder`, `productName: Twitch Highlight Recorder`, `win.target: nsis` (x64), `files: ['out/**']`, `asarUnpack: ['**/node_modules/better-sqlite3/**']`, `nsis.oneClick: false`.
- [ ] **Step 2: Написать `README.md`.** Требования (`winget install streamlink` и `winget install Gyan.FFmpeg`), запуск `npm install && npm run dev`, сборка `npm run dist`, таблица хоткеев из спеки, настройка Google OAuth, раздел «Точность маркеров» (как править `captureLatencyMs`/`markerOffsetMs`), известные ограничения: чат не встроен; рекламные вставки Twitch попадают в запись и могут сдвигать оценку времени; экспорт перекодирует видео.
- [ ] **Step 3: Написать `docs/smoke-checklist.md`** — нумерованный список из шагов ручной проверки Task 10–12 плюс: (a) отключить сеть на 20 с во время записи → `Переподключение…` → `LIVE`, маркер до разрыва и маркер после — в разных эпохах, клип из черновика после разрыва содержит только второй; (b) поставить маркер, подождать 7 минут, `F9` → авто-`F8` не захватывает старый маркер, но закрытие приложения собирает из него черновик (виден в «Библиотеке» после перезапуска); (c) закрыть приложение во время экспорта и во время загрузки в Drive → после перезапуска клип в «Не сохранены» / загрузка возобновляется; (d) запуск без `streamlink` в PATH → понятная ошибка в статусе; (e) второй запуск приложения фокусирует первое окно.
- [ ] **Step 4: Собрать и пройти чек-лист на Windows.** Run: `npm test` → PASS; `npm run dist` → установщик в `dist/`; установить, пройти `docs/smoke-checklist.md` целиком, отметить результат каждого пункта в файле.
- [ ] **Step 5: Commit** — `chore: windows packaging, readme and smoke checklist`.
