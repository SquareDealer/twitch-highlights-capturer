# Spike→composition trigger, interactive tuning, Drive sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The autoclip fires on a chat-speed spike made of trigger messages; thresholds are tuned by dragging them on live charts; taken clips are uploaded to an existing Google Drive folder by a «Sync» button.

**Architecture:** Part 1 changes the rule inside the Python detector (`ChatFrame` gains the message share, `EventAssembler` gates on spike then composition) and migrates stored profiles. Part 2 re-evaluates the same rule in the browser over the 300 frames it already holds, with a local draft of thresholds; the profile editor is rebuilt on the existing `FIELDS` table. Part 3 adds three service modules (settings, OAuth, sync queue) on top of the existing `createDriveClient`, new HTTP routes and a «Диск» tab.

**Tech Stack:** Python 3 (pytest), Node + TypeScript (vitest, better-sqlite3, google-auth-library), React 19, plain CSS in `src/web/styles.css`.

**Spec:** `docs/superpowers/specs/2026-11-17-spike-trigger-tuning-drive-design.md`

## Global Constraints

- Branch `feat/realtime-service`; the Electron app (`src/main` except `db/index.ts` migrations and `drive/driveClient.ts`, `src/renderer`, `src/preload`) is not changed.
- All user-facing text is Russian; code comments and identifiers are English.
- Defaults: `minSpike` 2.0, `minTriggerShare` 0.5, `shareFull` 0.9, `spikeFull` 6, `endSpike` 1.5, `minTriggerMessages` 3, `minTriggerAuthors` 2. They must be identical in `detector/hl_detector/config.py`, `src/service/config.ts`, `config.example.json`.
- Score: `1 + speed(0…5) + share(0…3) + audio(0…1)`, rounded to 0.1; `scores` keys stay `total/share/speed/audio`.
- Nothing reaches a running detector from the tuning panel until «Применить к профилю».
- The Google client secret and tokens never appear in an API response or SSE frame.
- OAuth scope: `https://www.googleapis.com/auth/drive`, `openid`, `email`.
- Tests: `npx vitest run`, `npm run typecheck` from the repo root; detector tests from `detector/` with `.venv/Scripts/python.exe -m pytest -q`. Commit after every task; commit messages end with the `Co-Authored-By` line used in this repo's recent commits.

## Review Focus

1. A silent window (`N = 0`) or a one-message tail second: `q` is 0 for `N = 0`, never divides by zero, and tail seconds never raise an event's share score. → Task 1.
2. A stored profile that predates the migration or lacks a key (hand-edited DB, seed from an old `config.json`): the service starts, the editor opens it, saving validates it. → Task 2.
3. The Google callback arriving twice, with a stale or unknown `state`, or after a service restart: a readable Russian page, no crash, no token written. → Tasks 9, 11.
4. A clip file that disappears between counting and uploading (janitor, manual delete): that clip is marked failed with a clear message and the rest still upload. → Task 10.
5. A threshold dragged past the chart edge, or a panel with zero frames: the value clamps to the field's `min…max`, counters show 0, no `NaN` in the DOM. → Tasks 4, 5.

---

## Part 1 — trigger rule

### Task 1: Detector rule, score and detail

**Files:**
- Modify: `detector/hl_detector/config.py` (DEFAULTS), `detector/hl_detector/chat.py` (`ChatFrame`, `ChatAnalyzer.tick`), `detector/hl_detector/events.py`, `detector/hl_detector/__main__.py` (detail + signals), `detector/README.md`
- Test: `detector/tests/test_chat.py`, `test_events.py`, `test_config.py`, `test_main.py`

**Interfaces — produces:**
- `DEFAULTS["chat"]`: add `"minSpike": 2.0`; `minTriggerShare` → `0.5`; remove `minActive`, `activeWindowS`. `DEFAULTS["score"]["shareFull"]` → `0.9`. `_POSITIVE` loses `("chat", "activeWindowS")`.
- `ChatFrame.trigger_share: float` = `trigger_messages / messages` (0.0 when `messages == 0`). `active_authors`, `active_authors_raw` are removed from the frame; `ChatAnalyzer._hist` now only serves `_rebased` and is trimmed by `base_ms + win_ms`.
- `EventAssembler.conditions(now_ms, frame) -> {"warm", "spike", "messages", "authors", "share", "fired"}`; `spike = frame.spike >= c["minSpike"]`; `fired` is the conjunction of all five.
- `_score`: `speed = _lin(chat_spike, c["minSpike"], s["spikeFull"], 5)`, `share = _lin(trigger_share, c["minTriggerShare"], s["shareFull"], 3)`.
- `_chat_feed(o, frame, fired: bool)`: `chat_spike`, `trigger_share`, `trigger_messages` maxima are updated only when `fired`; `laugh_messages`/`reaction_messages`/`laugh`/`reaction` as before.
- Near miss: emitted (rate limit unchanged) when no chat-open event and either `spike and not fired`, or `messages and authors and share and not spike and frame.spike >= c["endSpike"]`. `missing` lists the failed ones of `warm, spike, share, messages, authors` in that order. `values`: `spike, messages, triggerMessages, triggerAuthors, triggerShare`.
- Event `signals`: `chatSpike, triggerShare, triggerMessages, messages, laughShare, reactionShare, deltaDb` (no `activeAuthors`).
- `signals` line and `detail.chat`: drop `activeAuthors`/`activeAuthorsRaw`.

- [ ] **Step 1: Failing tests.** In `test_chat.py`: `test_trigger_share_is_share_of_messages` (window of 4 messages, 3 laugh → `trigger_share == 0.75`), `test_trigger_share_zero_on_empty_window`. In `test_events.py` (use the file's existing frame helper; build frames by fields):
  - `test_spike_without_composition_does_not_fire` (spike 3.0, share 0.2 → no event; near miss `missing == ["share"]`)
  - `test_composition_without_spike_does_not_fire` (spike 1.7, share 0.8, T=4, Ta=3 → no event; near miss `missing == ["spike"]`)
  - `test_composition_far_below_spike_is_silent` (spike 1.2, share 0.8 → no near miss)
  - `test_spike_and_composition_fire`
  - `test_audio_does_not_change_firing` (same frames with and without a 20 dB voice spike → same fired seconds; only `scores["audio"]` differs)
  - `test_score_weights` (spike 4.0, share 0.7, no audio → `speed == 2.5`, `share == 1.5`, `total == 5.0`)
  - `test_tail_seconds_do_not_raise_share` (fire at share 0.5; then a second with spike 1.6, `messages=1`, share 1.0 → event `signals["triggerShare"] == 0.5`, `scores["share"] == 0.0`)
  - `test_conditions_has_spike`
  Update existing tests that rely on the author share or `minActive`.
- [ ] **Step 2:** Run `.venv/Scripts/python.exe -m pytest -q` in `detector/` — new tests fail.
- [ ] **Step 3:** Implement per Interfaces. `open_state` and `preview` use the same `_score`; `preview` scores the current second only if its conditions hold except warm-up, otherwise speed and share are 0.
- [ ] **Step 4:** pytest green.
- [ ] **Step 5:** Commit `feat(detector): fire on chat spike made of trigger messages`.

### Task 2: Service settings, validation and profile migration

**Files:**
- Modify: `src/service/config.ts`, `src/service/profileSettings.ts`, `src/service/profiles.ts`, `src/main/db/index.ts` (comment only — the migration is code, see below), `src/service/detectorProcess.ts` (types), `src/service/types.ts`, `src/service/streams.ts` (near-miss values), `config.example.json`, `README.md`
- Test: `tests/service/profileSettings.test.ts`, `profiles.test.ts`, `config.test.ts`

**Interfaces — produces:**
- `DetectorConfig.chat`: `+ minSpike`, `− minActive`, `− activeWindowS`. `ProfileSettings.detector.chat` the same.
- `FieldDef` gains `sliderMin: number; sliderMax: number; step: number; display?: 'percent' | 'seconds'` (`percent`: stored 0–1 shown ×100; `seconds`: stored ms shown ÷1000) and `basic: boolean`.
- `FieldGroup = 'trigger' | 'event' | 'score' | 'audio' | 'cut' | 'windows'`; `windowS`, `baselineS`, `audio.baselineS`, `warmupS` move to `windows` («Окна»).
- Basic fields (`basic: true`), in this order: `detector.chat.minSpike` («Всплеск: чат быстрее фона в», ×, 1.1…20, slider 1.1…6, step 0.1), `detector.chat.minTriggerShare` («Состав: триггерных сообщений, не меньше», percent, 0.01…1, slider 0.1…1, step 0.05), `minTriggerMessages` (slider 1…20), `minTriggerAuthors` (slider 1…10), `cut.preRollMs`, `cut.postRollMs` (seconds, slider 0…60000, step 1000).
- `export function checkField(def: FieldDef, v: number): string | null` and `export function checkPairs(n: (path: string) => number): { error: string; path: string } | null` — the rules `validateSettings` already applies, extracted so the browser reuses them. Pair rules: `endSpike ≤ minSpike` (path `detector.chat.endSpike`), `spikeFull > minSpike`, `shareFull > minTriggerShare`, `audioFullDb > audioMinDb`, `maxClipMs ≥ postRollMs`.
- `export function migrateSettings(raw: unknown): ProfileSettings` — sets `minSpike = 2`, `minTriggerShare = 0.5`, `shareFull = 0.9`; `spikeFull = max(spikeFull, minSpike + 1)`; `endSpike = min(endSpike, minSpike)`; drops `minActive`, `activeWindowS`; any other missing numeric key is filled from `settingsFromConfig(defaultConfig(''))`. Idempotent on settings that already carry `minSpike` (those are returned with only missing keys filled).
- `export function factorySettings(): ProfileSettings` = `settingsFromConfig(defaultConfig(''))`.
- `ProfileService` constructor: after seeding, rewrites every row whose settings lack `detector.chat.minSpike` through `migrateSettings`; the seed itself also goes through it. (A code migration, not SQL: the values live in a JSON column.)
- `DetectorDetail.conditions` gains `spike: boolean`; `DetectorDetail.chat` loses `activeAuthors`, `activeAuthorsRaw`; `DetectorEvent.signals.messages?: number`.

- [ ] **Step 1: Failing tests.**
  - `profileSettings.test.ts`: `minSpike` bounds; each pair rule returns its path; `migrateSettings` on the pre-change default profile JSON (inline fixture with `minTriggerShare: 0.05, shareFull: 0.3, minActive: 10, activeWindowS: 300, endSpike: 3, spikeFull: 2.5`) → `minSpike 2, minTriggerShare 0.5, shareFull 0.9, endSpike 2, spikeFull 3`, no `minActive`; result passes `validateSettings`; `migrateSettings(migrateSettings(x))` deep-equals `migrateSettings(x)`; `migrateSettings({})` passes `validateSettings`.
  - `profiles.test.ts`: a DB pre-populated with an old-shape profile row → after `new ProfileService(db, seed)` `list()[0].settings.detector.chat.minSpike === 2` and other numbers (e.g. `cut.preRollMs`) are untouched; seed returning old-shape settings is stored migrated.
- [ ] **Step 2:** `npx vitest run tests/service` — fail.
- [ ] **Step 3:** Implement; update `config.example.json` and the README section on profile keys.
- [ ] **Step 4:** `npx vitest run tests/service && npm run typecheck` green (fix call sites the type changes break, including `tests/service/fixtures/fakeDetector.mjs`).
- [ ] **Step 5:** Commit `feat(service): minSpike, message-share validation, profile migration`.

### Task 3: Web copy for the new rule

**Files:**
- Modify: `src/web/tuning.ts` (`conditionRows`, `verdict`, `entryText`), `src/web/format.ts` (`clipSummary`), `src/web/components/ClipCard.tsx`
- Test: `tests/web/tuning.test.ts`, `format.test.ts`, `ClipCard.test.tsx`

**Interfaces — produces:** `conditionRows` returns rows in rule order: прогрев, всплеск (`×2,6`, need `≥ ×2,0`), состав (`62 % (8 из 13)`, need `≥ 50 %`), сообщений, авторов. `verdict` missing words: `прогрева, всплеска, состава, сообщений, авторов`. `entryText`: «доля» → «состав», `MISSING` gains `spike: 'всплеска', messages: 'сообщений'`. A clip whose `signals.activeAuthors !== undefined` keeps the old «доля» caption.

- [ ] **Step 1:** Tests for each string above, including an old clip fixture (`activeAuthors: 128`) rendering «доля».
- [ ] **Step 2:** Run — fail. **Step 3:** Implement. **Step 4:** `npx vitest run tests/web` green. **Step 5:** Commit `feat(web): spike and composition wording`.

---

## Part 2 — interactive tuning

### Task 4: Rule in the browser and factory defaults

**Files:**
- Modify: `src/web/tuning.ts`, `src/service/http.ts` (`/api/state`), `src/web/api.ts` (`AppState.factorySettings: ProfileSettings`), `src/web/App.tsx` (keep it in state, pass to `Streams` and `Profiles`)
- Test: `tests/web/tuning.test.ts`, `tests/service/http.test.ts`

**Interfaces — produces:**
```ts
export interface Thresholds { minSpike: number; minTriggerShare: number; minTriggerMessages: number; minTriggerAuthors: number }
export const thresholdsOf = (s: ProfileSettings): Thresholds
/** null: the frame cannot be judged (no detail). */
export function firedWith(f: DetectorSignals, t: Thresholds): boolean | null
/** Indexes of frames that start a firing: fired, and the previous judged frame did not. */
export function firingStarts(frames: DetectorSignals[], t: Thresholds): number[]
export function toDisplay(def: FieldDef, stored: number): number   // percent ×100, seconds ÷1000
export function fromDisplay(def: FieldDef, shown: number): number
export const clampField = (def: FieldDef, v: number): number       // to def.min…def.max, rounded to def.step
```
`firedWith` = `detail.conditions.warm && chat.spike >= minSpike && chat.triggerShare >= minTriggerShare && chat.triggerMessages >= minTriggerMessages && chat.triggerAuthors >= minTriggerAuthors`.

- [ ] **Step 1: Tests.** `firedWith` equals `detail.conditions.fired` on six frames built with the saved thresholds (one per failing condition plus one firing); frame without `detail` → `null`; `firingStarts` on `[f,F,F,f,F]` → `[1,4]`, on `[]` → `[]`, skipping `null` frames; `toDisplay`/`fromDisplay` round-trip for percent and seconds; `clampField` clamps `99` to max and `NaN` to `def.min`; `/api/state` returns `factorySettings` equal to `factorySettings()`.
- [ ] **Step 2–4:** fail → implement → green. **Step 5:** Commit `feat(web): evaluate the trigger rule on stored frames`.

### Task 5: Tuning panel — chain, draggable thresholds, draft

**Files:**
- Create: `src/web/components/ThresholdChart.tsx`, `src/web/components/TriggerChain.tsx`
- Modify: `src/web/components/TuningPanel.tsx`, `src/web/styles.css`; delete `src/web/components/Sparkline.tsx` if unused afterwards
- Test: `tests/web/ThresholdChart.test.tsx`, `TriggerChain.test.tsx`, `TuningPanel.test.tsx`

**Interfaces — produces:**
```ts
ThresholdChart(props: {
  label: string; values: number[]; marks: number[];          // marks: indexes into values («сработало бы»)
  threshold: number; savedThreshold: number; secondary?: { value: number; label: string };
  def: FieldDef;                                              // bounds, step, display unit
  onChange(stored: number): void;
})
TriggerChain(props: { detail: DetectorDetail; draft: Thresholds; saved: Thresholds; warmupS: number })
```
- `ThresholdChart`: SVG line chart; the threshold line is a `role="slider"` element (`aria-valuemin/max/now`, `aria-label` = label) draggable with pointer events (pointer capture; value from pointer Y mapped to the chart's value scale, then `clampField`); ArrowUp/ArrowDown change by `def.step`. Beside the chart: `−` / number input / `+`. The vertical scale tops at `max(def.sliderMax, …values, threshold)`. A dashed line shows `savedThreshold` when it differs.
- `TriggerChain`: three steps «① Всплеск», «② Состав», «③ Звук (бонус)» with value, need, a bar with a threshold tick, class `ok`/`bad`; step ② has class `dim` while step ① is not met; a warm-up row only while `!conditions.warm`; verdict line from `verdict()` evaluated with the **draft** thresholds via `firedWith`.
- `TuningPanel` state: `draft: Thresholds | null` (null = no changes). Charts: speed (`def` = minSpike, secondary = endSpike) and composition (`def` = minTriggerShare). Marks = `firingStarts(frames, draft ?? saved)`. Line under the charts: `С этими порогами за 5 минут: N срабатываний (с сохранёнными — M)` + note `слияние событий и часовой лимит не учитываются`. Buttons «Применить к профилю» (calls `api.updateProfile(profile.id, { settings })` with the four draft values written into the profile's settings; disabled without a draft) and «Сбросить». When `profile.updatedAt` changes while a draft exists: banner `Профиль изменён в другом окне` with «Оставить мои пороги» / «Взять новые». The warning «Изменения сразу подействуют на эфиры: …» (other streams on the profile) is shown next to «Применить». «Все настройки профиля» toggles the `ProfileEditor` (Task 6).

- [ ] **Step 1: Tests.** `ThresholdChart`: ArrowUp on the slider calls `onChange` with `threshold + step`; ArrowUp at `def.max` calls it with `def.max`; typing `abc` into the number input does not call `onChange`; renders with `values=[]` without `NaN` in `container.innerHTML`. `TriggerChain`: step ② has `dim` when spike fails; verdict follows the draft. `TuningPanel`: changing the speed threshold updates the marks count and counter text and makes **no** `api.updateProfile` call; «Применить к профилю» calls it once with `minSpike` changed and every other setting equal to the profile's; «Сбросить» restores the saved number; the outside-update banner appears and «Взять новые» clears the draft.
- [ ] **Step 2–4:** fail → implement (styles follow the existing `.tuning`, `.cond`, `.spark-row` rules; the chart must stay usable at 360 px width) → `npx vitest run tests/web && npm run typecheck` green.
- [ ] **Step 5:** Commit `feat(web): drag thresholds on live charts with a local draft`.

### Task 6: Profile editor

**Files:**
- Create: `src/web/components/NumberField.tsx`, `src/web/components/PatternChips.tsx`
- Modify: `src/web/components/ProfileEditor.tsx`, `src/web/views/Profiles.tsx`, `src/web/components/StreamCard.tsx` (prop pass-through), `src/web/styles.css`
- Test: `tests/web/ProfileEditor.test.tsx`, `NumberField.test.tsx`, `PatternChips.test.tsx`

**Interfaces — produces:**
```ts
NumberField(props: { def: FieldDef; value: string; factory: number; error?: string; onChange(text: string): void })
PatternChips(props: { label: string; patterns: string[]; bad: string[]; error?: string; onChange(next: string[]): void })
ProfileEditor(props: { profile: Profile; streams: StreamStatus[]; factory: ProfileSettings; onSaved?(p: Profile): void })
export function classifyMessage(text: string, laugh: string[], reaction: string[]): 'laugh' | 'reaction' | null   // in src/web/tuning.ts
```
- Form values stay text in **display** units (`toForm`/`fromForm` convert with `toDisplay`/`fromDisplay`).
- `NumberField`: label with a «?» button toggling the hint, range input over `sliderMin…sliderMax` (display units), text input for the full range, unit text (`%`, `с`, or `def.unit`), a dot + «вернуть» button when the parsed value differs from `factory`. Inline error = `props.error ?? checkField(def, parsed)`.
- Editor layout: name; «Основное» — the `basic` fields; then one `<details>` per group with its non-basic fields, summary `Группа · изменено N` (N = fields differing from `factory`, omitted when 0); «Словари» with two `PatternChips` and the «Проверить сообщение» input whose result reads `смех` / `реакция` / `не триггер`; a sticky bar `изменено N полей · [Сохранить] [Отменить]` (N = unsaved fields) shown only when dirty. Save stays explicit; `checkPairs` errors block saving client-side and are shown on their field (opening its `<details>`).
- `classifyMessage`: same normalisation as the detector (trim, lower-case, runs of 3+ equal characters collapsed to 2, split on whitespace); laugh wins over reaction; unsafe or uncompilable patterns are skipped.
- `PatternChips`: one chip per pattern with a remove button (`aria-label="Удалить <pattern>"`); input adds on Enter (trimmed, duplicates ignored); chips listed in `bad` get class `bad` and title `не используется детектором`.

- [ ] **Step 1: Tests.** `NumberField`: moving the slider calls `onChange` with the display value; percent field shows `50` for stored `0.5`; «вернуть» calls `onChange` with the factory display value; out-of-range text shows the `checkField` message. `PatternChips`: add, duplicate ignored, remove. `ProfileEditor`: basic fields are visible, «Оценка» is collapsed; editing `minSpike` to `5` with `endSpike 1.5`, `spikeFull 6` saves `detector.chat.minSpike === 5` and `cut.preRollMs` unchanged in ms; setting `spikeFull` below `minSpike` blocks save and shows the pair error; the sticky bar counts unsaved fields; «Проверить сообщение» with `ахахах` shows `смех`, with `привет` shows `не триггер`; a profile missing a key (cast fixture) renders without throwing and shows that field as empty with an error on save.
- [ ] **Step 2–4:** fail → implement → `npx vitest run tests/web && npm run typecheck && npm run web:build` green.
- [ ] **Step 5:** Commit `feat(web): profile editor with sliders, factory diff and pattern chips`.

---

## Part 3 — Google Drive

### Task 7: Storage — clip Drive columns and Drive settings

**Files:**
- Modify: `src/main/db/index.ts` (append one migration), `src/service/clipRepo.ts`, `src/service/types.ts`, `src/service/http.ts` (`publicClip`), `src/web/api.ts` (`PublicClip`)
- Create: `src/service/driveSettings.ts`
- Test: `tests/service/clipRepo.test.ts`, `tests/service/driveSettings.test.ts`

**Interfaces — produces:**
- Migration: `ALTER TABLE feed_clips ADD COLUMN drive_file_id TEXT; … drive_folder_id TEXT; … drive_status TEXT; … drive_error TEXT; … drive_synced_at TEXT;`
- `FeedClip` gains `driveFileId, driveFolderId, driveStatus: 'synced' | 'failed' | null, driveError, driveSyncedAt` (all nullable); `update()` accepts them.
- `clipRepo.driveQueue(folderId: string): FeedClip[]` — `status = 'taken' AND file_deleted = 0 AND NOT (drive_status = 'synced' AND drive_folder_id = ?)`, oldest first. `clipRepo.driveQueueCount(folderId): number`.
- `publicClip` drops the five columns and adds `drive: { status: 'synced' | 'failed'; url: string | null; error: string | null } | null`; `url = https://drive.google.com/file/d/<id>/view` when synced.
```ts
export interface DriveFolder { id: string; name: string; path: string }
export interface DriveSettings { clientId: string; clientSecret: string; folder: DriveFolder | null }
export function createDriveSettings(db: Db): {
  get(): DriveSettings;
  setCredentials(clientId: string, clientSecret: string): void;   // trims; changing clientId does not touch the folder
  setFolder(f: DriveFolder | null): void;
}
```
Stored in the existing `settings` table under keys `drive.clientId`, `drive.clientSecret`, `drive.folder` (JSON).

- [ ] **Step 1: Tests.** Queue returns only taken, present, not-synced-to-this-folder clips; a clip synced to folder `A` is queued again for folder `B`; a failed clip is queued; `publicClip` output has no `driveFileId` key and has `drive.url`; settings round-trip; `get()` on an empty table returns empty strings and `folder: null`.
- [ ] **Step 2–4:** fail → implement → green. **Step 5:** Commit `feat(service): Drive columns on clips and Drive settings store`.

### Task 8: Drive client — folder lookup

**Files:**
- Modify: `src/main/drive/driveClient.ts`
- Test: `tests/main/drive/driveClient.test.ts`

**Interfaces — produces (added to `DriveClient`):**
```ts
getFolder(id: string): Promise<{ id: string; name: string; path: string; canAddChildren: boolean } | null>  // null: 404 or not a folder
findFolders(name: string): Promise<Array<{ id: string; name: string; path: string }>>                       // not trashed, up to 20
export function folderIdFromLink(text: string): string | null
```
- Requests add `supportsAllDrives: 'true'` (and `includeItemsFromAllDrives` on lists); fields `id,name,mimeType,parents,capabilities(canAddChildren)`.
- `path` is built by walking `parents` up to 10 levels, joined with ` / `, root shown as `Мой диск`; a parent that cannot be read ends the walk with `…`.
- `folderIdFromLink` accepts a bare id (`[A-Za-z0-9_-]{10,}`), `…/folders/<id>` with any prefix (`/drive/u/0/`) and query string, and `…open?id=<id>`; anything else → `null`.
- `uploadFile`'s existing requests also get `supportsAllDrives`.

- [ ] **Step 1: Tests** with a fake `DriveRequest`: `getFolder` on a file mime → `null`; on 404 → `null`; path `Мой диск / Работа / to_sort`; `findFolders` escapes a quote in the name; `folderIdFromLink` for the four accepted shapes and for `https://example.com/x` → `null`.
- [ ] **Step 2–4:** fail → implement → `npx vitest run tests/main/drive` green. **Step 5:** Commit `feat(drive): folder lookup by id, name and link`.

### Task 9: Drive OAuth for the service

**Files:**
- Create: `src/service/driveAuth.ts`
- Test: `tests/service/driveAuth.test.ts`

**Interfaces — produces:**
```ts
export const DRIVE_CALLBACK_PATH = '/api/drive/callback';
export interface ServiceDriveAuthDeps {
  settings: ReturnType<typeof createDriveSettings>;
  tokenFile: string;                                   // <dataDir>/drive-token.json, written with mode 0o600
  createClient(opts: { clientId: string; clientSecret: string; redirectUri?: string }): OAuthLike;  // OAuthLike from src/main/drive/auth.ts
  now?: () => number;
}
export class ServiceDriveAuth {
  status(): Promise<{ connected: boolean; email?: string }>;
  /** origin: scheme://host[:port] the UI was opened at. */
  begin(origin: string): Result<{ url: string }>;       // error when keys are missing or the origin is not usable
  finish(state: string | null, code: string | null, error: string | null): Promise<Result<null>>;
  disconnect(): Promise<void>;                          // revoke (best effort) + delete the token file
  invalidate(): Promise<void>;                          // delete the token file only
  client(): Promise<OAuthLike | null>;                  // refreshed tokens are merged into the file
}
export function redirectProblem(origin: string): string | null
```
- `redirectProblem`: `null` for `http://localhost[:port]`, `http://127.0.0.1[:port]` and any `https://` origin whose host is not an IP address; otherwise the text `Google принимает адрес возврата только вида http://localhost или https:// с доменом. Откройте интерфейс по такому адресу.`
- `begin` keeps `{ state → { codeVerifier, redirectUri, expiresAt } }` in memory, at most 10 pending, each valid 10 minutes; PKCE S256; `access_type: 'offline'`, `prompt: 'consent'`.
- `finish`: unknown, used or expired state → `{ ok: false, error: 'Ссылка входа устарела. Начните подключение заново' }`; `error` param or no code → `'Доступ к Google Drive не выдан'`; a state is single-use even when the exchange fails.

- [ ] **Step 1: Tests** with a fake `OAuthLike`: `begin` without keys errors; `begin('http://192.168.1.5:8080')` errors with the `redirectProblem` text; happy path writes the token file and `status()` reports the e-mail from the id token; the same state a second time fails and writes nothing; a state older than 10 minutes fails; a `tokens` event without `refresh_token` keeps the stored one; `disconnect` removes the file even when `revokeToken` rejects; a new `ServiceDriveAuth` on the same file (restart) is connected, and a state from before the restart fails.
- [ ] **Step 2–4:** fail → implement → green. **Step 5:** Commit `feat(service): Google sign-in through the web UI`.

### Task 10: Sync service

**Files:**
- Create: `src/service/driveSync.ts`
- Test: `tests/service/driveSync.test.ts`

**Interfaces — produces:**
```ts
export interface DriveSyncState { running: boolean; done: number; total: number; failed: number; pending: number; lastError: string | null }
export class DriveSync extends EventEmitter {           // events: 'state' (DriveSyncState), 'clip' (FeedClip)
  constructor(deps: {
    clips: ReturnType<typeof createClipRepo>;
    settings: ReturnType<typeof createDriveSettings>;
    getClient(): Promise<DriveClient | null>;
    onAuthLost(): Promise<void>;
    now?: () => Date;
  });
  state(): DriveSyncState;                               // pending = driveQueueCount(folder) or 0 without a folder
  start(): Result<DriveSyncState>;                       // refuses when not connected / no folder; no-op returning state when running
  idle(): Promise<void>;                                 // resolves when the current run ends (tests, shutdown)
  stop(): void;                                          // no further clips after the current one
}
export const driveFileName = (c: FeedClip): string     // `${c.streamer}_${basename(c.mp4Path)}`
```
- One clip at a time. Per clip: file missing on disk → `driveStatus 'failed'`, `driveError 'Файл клипа не найден на диске'`, continue. Upload with `client.uploadFile({ localPath, name: driveFileName(c), parentId: folder.id, mimeType: 'video/mp4', existingFileId: c.driveFolderId === folder.id ? c.driveFileId ?? undefined : undefined })`; on success set `synced`, ids, `driveSyncedAt`, clear the error. Each clip change emits `'clip'`.
- Errors by `httpStatus`: 401 or a message containing `invalid_grant` → `onAuthLost()`, stop the run, `lastError 'Доступ к Google Drive отозван. Подключите аккаунт заново'`; 404 on the folder → stop, `'Папка выгрузки не найдена на Google Drive. Выберите её заново'`; 403 with `storageQuotaExceeded` → stop, `'На Google Drive закончилось место'`; anything else → that clip `failed` with the message, continue.
- A clip whose status stops being `taken` before its turn is skipped.

- [ ] **Step 1: Tests** with a fake `DriveClient`: uploads only queued clips, in order, with the expected names; a second `start()` during a run does not start a second upload of the same clip; second run after success uploads nothing; missing file → that clip failed, next one uploaded; generic error on clip 1 → clip 2 still uploaded, `failed === 1`; 401 → `onAuthLost` called once, clip 2 untouched, `lastError` set; changing the folder re-queues synced clips and passes no `existingFileId`; `start()` without folder returns the error `Выберите папку выгрузки на вкладке «Диск»`, without client `Google Drive не подключён`.
- [ ] **Step 2–4:** fail → implement → green. **Step 5:** Commit `feat(service): upload taken clips to the chosen Drive folder`.

### Task 11: HTTP routes and wiring

**Files:**
- Modify: `src/service/http.ts`, `src/service/main.ts`
- Test: `tests/service/http.test.ts`, `tests/service/main.test.ts`

**Interfaces — produces:**
- `HttpDeps.drive: { settings; auth: ServiceDriveAuth; sync: DriveSync; client(): Promise<DriveClient | null> }`.
- `GET /api/drive` → `DriveStatus = { hasCredentials: boolean; clientId: string; connected: boolean; email: string | null; folder: DriveFolder | null; redirectUri: string; redirectProblem: string | null; sync: DriveSyncState }`. `redirectUri` = request origin (`Origin` header, else `http://<Host>`; `https` when `X-Forwarded-Proto: https`) + `DRIVE_CALLBACK_PATH`.
- `PUT /api/drive/credentials { clientId, clientSecret }` — both non-empty strings ≤ 300 chars, else 400; an empty `clientSecret` with an unchanged `clientId` keeps the stored secret. Changing the keys calls `auth.invalidate()`.
- `POST /api/drive/connect` → `{ url }` or 400 with the error. `POST /api/drive/disconnect` → 204.
- `GET /api/drive/callback?state&code&error` — **no session check, no origin check**; calls `auth.finish`; answers `302 Location: /#drive` on success, otherwise a 400 HTML page (same CSP headers as static pages) with the error text and a link «Вернуться» to `/#drive`.
- `GET /api/drive/folders?name=` (1…200 chars) → folder list; 409 `Google Drive не подключён` when no client.
- `PUT /api/drive/folder { id? , link? }` → resolves with `folderIdFromLink`, `getFolder`; 400 `Это не ссылка на папку Google Drive`, 404 `Папка не найдена или к ней нет доступа`, 409 `В эту папку нельзя добавлять файлы`; stores and returns the status.
- `POST /api/drive/sync` → 202 with `DriveSyncState`, or 409 with the refusal text.
- SSE: `drive` (full `DriveStatus` minus `redirectUri`/`redirectProblem`, sent on every sync `'state'` event and after any settings change); sync `'clip'` events go out as the existing `clip` event.
- `readsBody` covers the two new `PUT`s. Every route above except the callback sits behind the existing session and origin checks.
- `main.ts`: builds the three objects (`createClient` = `new OAuth2Client(opts)` from `google-auth-library`; `client()` = `createDriveClient(oauth.request.bind(oauth))`), `onAuthLost = auth.invalidate`, `sync.stop()` then `await sync.idle()` in `shutdown` before the database closes.

- [ ] **Step 1: Tests.** `GET /api/drive` body contains no `clientSecret` key and no token text; unauthenticated requests to every route but the callback → 401; callback with an unknown state → 400 HTML containing `Ссылка входа устарела`, with a good state → 302 to `/#drive`; `PUT /api/drive/folder` with a file link → 404; `POST /api/drive/sync` unconnected → 409; a sync state change is broadcast as a `drive` SSE frame without the secret; `main.test.ts`: service starts and shuts down with Drive never configured.
- [ ] **Step 2–4:** fail → implement → `npx vitest run tests/service && npm run typecheck` green. **Step 5:** Commit `feat(service): Drive API routes`.

### Task 12: Web — «Диск» tab, Sync button, clip badge

**Files:**
- Create: `src/web/views/Drive.tsx`, `src/web/components/SyncButton.tsx`
- Modify: `src/web/api.ts`, `src/web/App.tsx`, `src/web/views/Feed.tsx`, `src/web/components/ClipCard.tsx`, `src/web/styles.css`, `README.md` (new section «Google Drive (веб-сервис)»)
- Test: `tests/web/Drive.test.tsx`, `SyncButton.test.tsx`, `ClipCard.test.tsx`, `subscribe.test.ts`

**Interfaces — produces:**
- `api.drive()`, `api.setDriveCredentials(clientId, clientSecret)`, `api.driveConnect()`, `api.driveDisconnect()`, `api.driveFolders(name)`, `api.setDriveFolder({ id } | { link })`, `api.driveSync()`; `SubscribeHandlers.drive`.
- `App`: `Screen` gains `'drive'`; the tab is selected when `location.hash === '#drive'` on load; drive status loaded in `load()` and updated from SSE (keeping `redirectUri`/`redirectProblem` from the last `GET`).
- `Drive` view: three numbered steps as in the spec sketch. Step ① shows the redirect address with «Копировать» and a short how-to (create an OAuth client of type «Web application», enable Drive API, add this address, switch the app to «In production» or sign-in expires every 7 days); `redirectProblem` replaces the address with the warning. The secret input is empty with placeholder `сохранён` when `hasCredentials`. Step ② «Подключить Google Drive» does `location.assign(url)`; disabled until step ① is done. Step ③ is disabled until connected: «Найти по имени» (prefilled `to_sort`) lists matches as radio rows `name · path` with «Выбрать»; zero matches → `Папок с таким именем нет`; a link field with «Выбрать по ссылке».
- `SyncButton(props: { drive: DriveStatus | null; onSync(): Promise<void>; onOpenDrive(): void })`: label `Sync (N)`; while running `Sync · 3 из 7`; disabled with title `Все взятые клипы уже на Диске` when `N === 0`; when not connected or no folder it is a link-style button `Sync: настроить Диск` calling `onOpenDrive`; title otherwise `Выгрузить все взятые клипы на Google Drive`; `lastError` shown beside it; after a run with failures: `не выгружено: K`.
- `ClipCard`: badge `на Диске` linking to `clip.drive.url` (`target="_blank" rel="noreferrer"`), or `ошибка выгрузки` with `title = clip.drive.error`.

- [ ] **Step 1: Tests.** `Drive`: step ② disabled without credentials; the secret is never rendered; folder search renders rows and choosing one calls `api.setDriveFolder({ id })`; `redirectProblem` shown. `SyncButton`: the five states above. `ClipCard`: both badges. `subscribe`: `drive` frames reach the handler.
- [ ] **Step 2–4:** fail → implement → `npx vitest run && npm run typecheck && npm run web:build` green. **Step 5:** Commit `feat(web): Drive tab and Sync button`.

### Task 13: Whole-run verification

- [ ] **Step 1:** `npx vitest run`, `npm run typecheck`, `npm run web:build`, detector pytest — all green; paste the summaries.
- [ ] **Step 2:** Live check without the user's data: start the service with `HL_CONFIG`/`HL_DATA` pointing at a scratch folder (copy of `config.json`, another port, `diskReserveBytes: 0`), start a live channel with an active chat, open «Настройка»: chain and charts update each second; drag the speed threshold — marks and counter change, the stream card's detector restart counter does not; «Применить к профилю» — the chain's `нужно` value follows within two seconds. Open «Профили»: sliders, «вернуть», chips, «Проверить сообщение».
- [ ] **Step 3:** Drive without Google keys: «Диск» shows the redirect address; «Sync» reads `Sync: настроить Диск`. With a scratch DB opened from an old-shape profile row, the service starts and the profile shows `×2` / `50 %`.
- [ ] **Step 4:** Append the results to `docs/smoke-checklist-service.md` (what was checked, what the customer must check with their Google account: sign-in, choosing the existing `to_sort`, Sync of two taken clips, a second Sync creating no duplicates). Commit `docs: live check of the spike trigger, tuning and Drive`.
