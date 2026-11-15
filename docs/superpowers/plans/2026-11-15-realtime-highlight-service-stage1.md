# Realtime Highlight Service — первая очередь (пилот). Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сервис без окна, который по ссылке на Twitch-эфир пишет до 5 эфиров, детектором по чату и звуку вырезает кандидатов в MP4 без перекодирования и показывает их в веб-ленте с предпросмотром, статусами и скачиванием.

**Architecture:** Node-процесс (`src/service/`) переиспользует захват, кольцевой буфер и SQLite из `src/main/` и поднимает HTTP API + React SPA (`src/web/`). На каждый эфир — свой `CaptureSessionManager`, свой `RingBufferManager` и свой Python-процесс детектора (`detector/`), который получает PCM по stdin, сам читает чат Twitch IRC и отдаёт события JSON-строками. Код Electron не трогаем и не используем (удаление — вторая очередь).

**Tech Stack:** Node 24, TypeScript, `tsx` (запуск сервиса), `node:http`, better-sqlite3, React 19 + Vite, Vitest; Python 3.10, numpy, onnxruntime, silero-vad (ONNX), websockets, pytest; FFmpeg, Streamlink.

**Spec:** `docs/superpowers/specs/2026-11-15-realtime-highlight-service-design.md` — §12 «Первая очередь». Вторая очередь (роли, экран настроек, F0/flux, replay, удаление Electron) в этот план не входит.

## Global Constraints

- Видео никогда не перекодируется: только `-c copy`.
- Никакой ASR, LLM, PANNs, OCR. Код clips-studio не копируется.
- Все пользовательские тексты (UI, ошибки API) — на русском.
- Все числа детектора и нарезки — в конфигурации, значения по умолчанию взяты из спека дословно (см. Task 3).
- Существующие тесты `tests/main/**` должны оставаться зелёными; изменения сигнатур в `src/main/capture/*` сопровождаются правкой их тестов и `src/main/app.ts`.
- Падение детектора или чата не останавливает запись эфира.
- «Новые» и «взятые» клипы сервис не удаляет никогда.
- Python-код — только стандартная библиотека + numpy, onnxruntime, websockets; тесты детектора не требуют сети и модели (VAD подменяется).
- Коммит после каждой задачи; сообщения в стиле репозитория (`feat: …`, `fix: …`).

## Review Focus

1. **Событие указывает на данные, которых уже нет в буфере или которые в другой эпохе** (детектор отстал, было переподключение) → клип режется из того, что есть в эпохе события; если нет ни одного сегмента — запись в ленте со статусом `error`, сервис не падает. Тест: Task 9.
2. **Чат отвалился посреди эфира / IRC прислал мусор** (не-UTF-8, сообщение без тегов, только эмодзи, 500 символов одной буквы) → детектор не падает, сообщает `status: chat disconnected`, переподключается; аудиотриггер работает. Тесты: Task 4 (нормализация), Task 7 (переподключение).
3. **Вставили не то** (ссылка не на Twitch, канал офлайн, VOD-ссылка `twitch.tv/videos/123`, пустая строка) → понятная русская ошибка от `POST /api/probe`, эфир не создаётся. Тест: Task 11.
4. **Диск заполнился во время склейки** → частичный `.part` удаляется, клип `error`, нарезка ставится на паузу, запись продолжается. Тест: Task 9 и Task 12.
5. **Двое одновременно меняют статус одного клипа / запрос к удалённому файлу отклонённого клипа** → последний запрос побеждает без ошибки; предпросмотр удалённого файла отдаёт 404, карточка показывает «файл удалён». Тест: Task 11.

---

### Task 1: Захват — звук для детектора, качество на эфир, конец эфира

**Files:**
- Modify: `src/main/capture/processes.ts`, `src/main/capture/sessionManager.ts`, `src/main/app.ts` (подстроить вызовы), `src/shared/types.ts`
- Create: `src/main/capture/concat.ts` (перенос `concatSegments` и типа `ConcatFn` из `src/main/moments/draftService.ts`; там оставить реэкспорт)
- Test: `tests/main/capture/processes.test.ts`, `tests/main/capture/sessionManager.test.ts`

**Interfaces — Produces:**
```ts
// processes.ts
export type ProbeResult = { live: true; streamId: string; qualities: string[] } | { live: false; reason: string };
export interface CaptureProcs { onExit(cb: (reason: string) => void): void; stop(): Promise<void>; pcm: Readable | null }
export interface CaptureOptions { quality: string; pcm: boolean }
export interface ProcessRunner {
  probe(channel: string): Promise<ProbeResult>;
  checkBinaries(): Promise<string | null>;
  spawnCapture(channel: string, epochDir: string, opts: CaptureOptions): CaptureProcs;
}
export function ffmpegSegmentArgs(epochDir: string, segmentSeconds: number, pcm: boolean): string[];
export type RunnerSettings = Pick<Settings, 'streamlinkPath' | 'ffmpegPath' | 'segmentSeconds'>;
export function createProcessRunner(getSettings: () => RunnerSettings): ProcessRunner;

// sessionManager.ts — deps: вместо `settings: SettingsStore` и `timeSync`
//   bufferDir: string; offlineEndMs?: number (default 300_000); timeSync?: TimeSynchronizer (необязателен)
start(channel: string, opts?: { quality?: string; pcm?: boolean }): Promise<void>;   // quality default 'best'
// новые события:
//   'epoch'  ({ epoch: number; pcm: Readable | null })  — сразу после запуска процессов эпохи
//   'ended'  (session: CaptureSession)                   — канал офлайн дольше offlineEndMs; после него вызывается stop()
```

- [ ] **Step 1: Тесты `processes.test.ts`**

```ts
it('adds a 16 kHz mono PCM output on stdout when pcm is on', () => {
  const a = ffmpegSegmentArgs('D:/b/e0', 2, true);
  expect(a.slice(-9)).toEqual(['-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1']);
});
it('keeps the old argument list when pcm is off', () => {
  expect(ffmpegSegmentArgs('D:/b/e0', 2, false)).not.toContain('pipe:1');
});
it('returns the quality names from streamlink --json', () => {
  const r = parseProbeOutput(JSON.stringify({ metadata: { id: 42 }, streams: { '720p60': {}, best: {}, worst: {}, audio_only: {} } }));
  expect(r).toEqual({ live: true, streamId: '42', qualities: ['best', '720p60', 'worst', 'audio_only'] });
});
```
Порядок качеств: `best` первым, затем остальные в порядке ключей; нет `streams` → `['best']`.

- [ ] **Step 2: Запустить `npx vitest run tests/main/capture/processes.test.ts` — FAIL**
- [ ] **Step 3: Реализовать в `processes.ts`.** При `pcm: true` у FFmpeg `stdio: ['pipe','pipe','pipe']`, `CaptureProcs.pcm = ffmpeg.stdout`; иначе `null`. Качество берётся из `opts.quality`, а не из настроек.
- [ ] **Step 4: Тесты `sessionManager.test.ts`** (подменный `ProcessRunner` из существующих тестов расширить полем `pcm`):

```ts
it("emits 'epoch' with the pcm stream for every (re)connection", …);          // после start и после reconnect: epoch 0, затем 1
it('passes the requested quality to spawnCapture', …);                        // start('foo', { quality: '720p60' })
it("emits 'ended' and stops when the channel stays offline for offlineEndMs", …); // probe → live:false, sleep подменён, offlineEndMs: 300_000
```
- [ ] **Step 5: Реализовать в `sessionManager.ts`.** В `reconnectLoop` копить суммарную паузу; при превышении `offlineEndMs` — `emit('ended', session)` и `stop()`. `timeSync` вызывать через `?.`. `bufferDir` брать из deps. Поправить `app.ts` (передать `bufferDir`, `timeSync`) и `draftService.ts` (импорт concat).
- [ ] **Step 6: `npx vitest run` — все тесты PASS; `npm run typecheck` — без ошибок**
- [ ] **Step 7: Commit** `feat: per-session quality, pcm tap and end-of-stream detection in capture`

---

### Task 2: Таблица клипов ленты

**Files:**
- Modify: `src/main/db/index.ts` (добавить миграцию в конец `MIGRATIONS`)
- Create: `src/service/types.ts`, `src/service/clipRepo.ts`
- Test: `tests/service/clipRepo.test.ts`

**Interfaces — Produces:**
```ts
// src/service/types.ts
export type Trigger = 'laugh' | 'mass' | 'audio' | 'manual';
export type ClipStatus = 'pending' | 'new' | 'taken' | 'rejected' | 'error';
export interface DetectorEvent {
  epoch: number; startMs: number; endMs: number;
  triggerTimeMs: number; estimatedEventMs: number; uncertaintyMs: number;
  triggers: Trigger[]; confidence: 'normal' | 'low';
  scores: { S: number; C: number; E: number; U: number; A: number };
  signals: { chatSpike: number; laughShare: number; reactionShare: number; deltaDb: number };
}
export interface FeedClip {
  id: string; sessionId: string; streamer: string; streamId: string; epoch: number;
  startMs: number; endMs: number; durationMs: number; bytes: number;
  triggers: Trigger[]; confidence: 'normal' | 'low'; score: number;
  signals: DetectorEvent['signals'];
  status: ClipStatus; error: string | null; mp4Path: string; jsonPath: string;
  fileDeleted: boolean; createdAt: string; statusChangedAt: string | null;
}
// src/service/clipRepo.ts
export function createClipRepo(db: Db): {
  insert(c: FeedClip): void;
  get(id: string): FeedClip | null;
  list(filter?: { streamer?: string; status?: ClipStatus; limit?: number }): FeedClip[];  // новые сверху, limit default 200
  update(id: string, patch: Partial<Pick<FeedClip, 'status' | 'error' | 'durationMs' | 'bytes' | 'fileDeleted' | 'statusChangedAt'>>): void;
  countSince(sessionId: string, sinceIso: string): number;       // статусы кроме 'error'
  scoresSince(sessionId: string, sinceIso: string): number[];
  rejectedWithFiles(olderThanIso?: string): FeedClip[];
  failPending(error: string): number;                             // 'pending' → 'error'
};
```
Таблица `feed_clips` (snake_case колонки тех же полей; `triggers` и `signals` — JSON-текст; индексы по `(streamer, created_at)` и `(status)`).

- [ ] **Step 1: Тест** — вставка и чтение сохраняют все поля; `list({ status: 'new' })` фильтрует и сортирует по `createdAt` убыванию; `failPending('Сервис был перезапущен')` меняет только `pending`; `countSince` не считает `error`.
- [ ] **Step 2: Запустить — FAIL**
- [ ] **Step 3: Реализовать миграцию и репозиторий** (стиль `src/main/db/repos.ts`)
- [ ] **Step 4: `npx vitest run tests/service/clipRepo.test.ts tests/main/db` — PASS**
- [ ] **Step 5: Commit** `feat: feed clips table and repository`

---

### Task 3: Конфигурация сервиса

**Files:**
- Create: `src/service/config.ts`, `config.example.json`
- Test: `tests/service/config.test.ts`

**Interfaces — Produces:**
```ts
export interface DetectorConfig {
  chat: { windowS: 5; baselineS: 300; alpha: 1; minMessages: 8; minAuthors: 5; laughSpike: 3; laughShare: 0.3;
          massSpike: 6; massMinMessages: 15; massMinAuthors: 10; massReactionShare: 0.2; repeatShare: 0.6; endSpike: 1.5;
          laughWords: string[]; reactionWords: string[]; interactiveWords: string[] };
  audio: { blockMs: 100; baselineS: 45; spikeDb: 10; spikeVad: 0.5; spikeMinMs: 300;
           triggerDb: 15; triggerVad: 0.7; triggerMinMs: 500 };
  events: { warmupS: 60; lookbackS: 20; chatLagS: 8; voiceWindowS: 20; mergeGapS: 10; maxEventS: 60 };
  weights: { C: 0.35; E: 0.25; U: 0.2; A: 0.2 };
}   // числа выше — значения по умолчанию; типы полей — number
export interface ServiceConfig {
  port: number;                 // 8080
  password: string;             // обязателен, пустой → ошибка запуска
  dataDir: string; libraryDir: string; bufferDir: string;   // по умолчанию <dataDir>/library, <dataDir>/buffer
  streamlinkPath: string; ffmpegPath: string; pythonPath: string;   // 'streamlink', 'ffmpeg', 'python'
  multiStream: boolean;         // false
  maxStreams: number;           // 5
  bufferSeconds: number;        // 300
  segmentSeconds: number;       // 2
  preRollMs: number;            // 15000
  preRollLowConfidenceMs: number; // 30000
  postRollMs: number;           // 10000
  maxClipMs: number;            // 90000
  manualClipMs: number;         // 60000
  maxClipsPerHour: number;      // 20
  diskReserveBytes: number;     // 10 * 1024**3
  rejectedTtlHours: number;     // 24
  offlineEndMs: number;         // 300000
  detector: DetectorConfig;
}
export function defaultConfig(dataDir: string): ServiceConfig;
export function loadConfig(file: string, dataDir: string): ServiceConfig;   // глубокое слияние с умолчаниями; неверный тип поля → Error с именем поля
export function saveConfigPatch(file: string, patch: Partial<Pick<ServiceConfig, 'multiStream'>>): void;
```
Словари по умолчанию (регулярные выражения, без учёта регистра, применяются к нормализованному токену):
- `laughWords`: `^(а*х+а+х*)+[ах]*$` (ахах/хаха), `^(a*h+a+h*)+[ah]*$`, `^ору+$`, `^ржу+$`, `^ло+л$`, `^ке+к$`, `^пхп+$`, `^хд+$`, `^lo+l$`, `^lmao+$`, `^xd+$`, `^kekw$`, `^lul$`, `^omegalul$`, `^icant$`, `😂`, `🤣`
- `reactionWords`: `^не+т+$`, `^что+$`, `^wtf+$`, `^f$`, `^pog(gers|champ)?$`, `^о+мг$`, `^omg+$`, `^жесть$`, `^капец$`, `^rip$`
- `interactiveWords`: `^\d+$`, `^[+\-]+$`, `^да+$`, `^нет$`, `^[a-dа-г]$`, `^yes$`, `^no$`

Примечание: `^нет$` (ровно одно «е» и одно «т») — интерактив; `нееет`/`неттт` — реакция. Порядок классификации токена: смех → реакция → интерактив → неизвестный, но `^нет$` проверяется до реакции.

- [ ] **Step 1: Тест** — `defaultConfig('D:/d').detector.chat.massSpike === 6`; файл `{ "password": "x", "preRollMs": 20000 }` даёт `preRollMs 20000` и остальные умолчания; `{ "password": "" }` и `{ "port": "80" }` бросают ошибку с именем поля; `saveConfigPatch` меняет только `multiStream` и сохраняет остальные ключи файла.
- [ ] **Step 2: FAIL → Step 3: Реализовать → Step 4: PASS**
- [ ] **Step 5: Commit** `feat: service configuration with spec defaults`

---

### Task 4: Детектор — признаки чата

**Files:**
- Create: `detector/pyproject.toml` (пакет `hl_detector`, зависимости: numpy, onnxruntime, websockets; dev: pytest), `detector/hl_detector/__init__.py`, `detector/hl_detector/config.py`, `detector/hl_detector/chat.py`
- Test: `detector/tests/test_chat.py`

**Interfaces — Produces:**
```python
# config.py
def load_config(path: str) -> dict            # JSON из Task 3 (поле detector) как есть
DEFAULTS: dict                                # те же значения по умолчанию, что в Task 3

# chat.py
@dataclass
class ChatMessage: t_ms: int; user: str; text: str          # t_ms — в шкале эфира
@dataclass
class ChatFrame:
    t_ms: int; messages: int; authors: int
    spike: float; author_spike: float          # (M+α)/(фон+α)
    rarity: float; author_rarity: float        # квантиль 0..1 среди окон фона
    laugh_share: float; reaction_share: float
    repeat_class: str | None                   # 'emotional' | 'interactive' | 'unknown' | None
    warm: bool                                 # накоплено ≥ 60 с фона
def normalize(text: str) -> str               # lower, обрезка пробелов, повторы символа >2 сжимаются до 2, первые 40 символов
def classify(token: str, cfg) -> str          # 'laugh' | 'reaction' | 'interactive' | 'unknown'
class ChatAnalyzer:
    def __init__(self, cfg: dict): ...
    def add(self, msg: ChatMessage) -> None
    def tick(self, now_ms: int) -> ChatFrame   # вызывается раз в секунду
    def mark_spike(self, t_ms: int) -> None    # окно исключается из фона
```
Сообщение считается смехом/реакцией, если так классифицирован хотя бы один его токен (разбиение по пробелам). Повтор: доля самого частого нормализованного текста длиной ≤ 12 символов ≥ `repeatShare`; его класс — `emotional` для laugh/reaction. Фон: значения `messages` (и `authors`) по секундным тикам за `baselineS`, кроме помеченных `mark_spike`; `M_фон` — медиана.

- [ ] **Step 1: Тесты**

```python
def feed(a, t0, n, text, users=None): ...   # n сообщений равномерно за 5 с от разных авторов

def test_small_chat_baseline_is_not_zero():      # 1 сообщение каждые 4 с в течение 120 с → frame.spike < 1.6 на спокойном тике
def test_spike_ratio_uses_alpha():               # фон 2 сообщения/окно, сейчас 11 → spike == (11+1)/(2+1) == 4.0
def test_laugh_share_counts_variants():          # ['ахахах','ХАХА','KEKW','ору','привет'] → 0.8
def test_reaction_share():                       # ['НЕЕЕЕТ','wtf','F','что','ок'] → 0.8
def test_repeat_interactive():                   # 7 из 10 сообщений '1' → repeat_class == 'interactive'
def test_repeat_emotional():                     # 5×'НЕЕЕЕТ', 'WTF', 'F', 'АХАХАХ' → 'emotional' (пример из правок заказчика, 62,5 %)
def test_repeat_unknown():                       # 8 из 10 'gta 6' → 'unknown'
def test_plain_net_is_interactive_but_neeet_is_reaction():
def test_marked_spike_is_excluded_from_baseline():
def test_garbage_does_not_crash():               # '', 500×'а', '\udcff', только эмодзи, текст без пробелов 2000 символов
def test_not_warm_before_60s():
```
- [ ] **Step 2: `cd detector && python -m pytest tests/test_chat.py -v` — FAIL**
- [ ] **Step 3: Реализовать `config.py` и `chat.py`** (deque по времени; квантиль — доля значений фона, строго меньших текущего)
- [ ] **Step 4: PASS**
- [ ] **Step 5: Commit** `feat(detector): chat features with robust baseline and repeat classes`

---

### Task 5: Детектор — признаки звука

**Files:**
- Create: `detector/hl_detector/audio.py`, `detector/hl_detector/vad.py`
- Test: `detector/tests/test_audio.py`

**Interfaces — Produces:**
```python
# vad.py
class Vad(Protocol):
    def prob(self, samples: np.ndarray) -> float      # float32 [-1,1], 16 кГц, 100 мс → вероятность речи 0..1
    def reset(self) -> None
class SileroVad:                                      # onnxruntime, CPU, 1 поток; модель silero_vad.onnx из пакета silero-vad
    def __init__(self, model_path: str | None = None): ...
# audio.py
@dataclass
class VoiceSpike: start_ms: int; end_ms: int; peak_db: float; strong: bool   # strong = условие независимого триггера
@dataclass
class AudioFrame: t_ms: int; db: float; delta_db: float; vad: float; warm: bool
class AudioAnalyzer:
    def __init__(self, cfg: dict, vad: Vad): ...
    def feed(self, pcm: bytes) -> None                # s16le моно 16 кГц, любыми кусками
    def frames(self) -> list[AudioFrame]              # новые блоки по 100 мс с прошлого вызова
    def spikes(self) -> list[VoiceSpike]              # завершившиеся всплески с прошлого вызова
    def recent_spikes(self, from_ms: int, to_ms: int) -> list[VoiceSpike]   # хранить 120 с
    def reset(self) -> None                           # новая эпоха: t_ms с нуля, фон сброшен, VAD reset
```
`t_ms` = число принятых отсчётов / 16. `db = 20·log10(rms)`, пол −90. Фон — медиана `db` блоков с `vad ≥ spikeVad` за `baselineS`; пока таких блоков меньше 50 — `warm = False`, всплесков нет. Всплеск: подряд блоки с `delta_db ≥ spikeDb` и `vad ≥ spikeVad`, длительность ≥ `spikeMinMs`; `strong`, если внутри есть участок ≥ `triggerMinMs` с `delta_db ≥ triggerDb` и `vad ≥ triggerVad`. Блоки самого всплеска в фон не попадают.

- [ ] **Step 1: Тесты** (подменный `FakeVad(prob)`; сигнал — синус заданной амплитуды)

```python
def test_block_timing():                       # 1 с PCM кусками по 333 байта → ровно 10 кадров, t_ms 0,100,…,900
def test_voice_spike_plus_10db():              # 30 с речи на −30 dBFS, затем 0,5 с на −18 → один VoiceSpike, strong False
def test_strong_spike_plus_15db_500ms():       # затем 0,6 с на −12 → strong True
def test_loud_without_speech_is_ignored():     # тот же скачок при vad 0.1 → spikes() == []
def test_short_blip_is_ignored():              # 200 мс на +20 дБ → нет всплеска
def test_no_spikes_until_warm():
def test_reset_restarts_timeline():
```
- [ ] **Step 2: `python -m pytest tests/test_audio.py -v` — FAIL → Step 3: Реализовать → Step 4: PASS**
- [ ] **Step 5: Добавить `detector/tests/test_silero_smoke.py`** с `pytest.mark.skipif(модель не установлена)`: `SileroVad().prob(тишина) < 0.3`. Запустить, PASS или SKIP.
- [ ] **Step 6: Commit** `feat(detector): loudness and voice spike features`

---

### Task 6: Детектор — триггеры, сборка событий, оценка

**Files:**
- Create: `detector/hl_detector/events.py`
- Test: `detector/tests/test_events.py`

**Interfaces:**
- Consumes: `ChatFrame`, `ChatAnalyzer.mark_spike` (Task 4); `VoiceSpike`, `AudioAnalyzer.recent_spikes` (Task 5).
- Produces:
```python
@dataclass
class Event:
    epoch: int; start_ms: int; end_ms: int
    trigger_time_ms: int; estimated_event_ms: int; uncertainty_ms: int
    triggers: list[str]            # из 'laugh', 'mass', 'audio' — без повторов, в порядке появления
    confidence: str                # 'normal' | 'low'
    scores: dict                   # S, C, E, U, A — 0..1, округление до 3 знаков
    signals: dict                  # chatSpike, laughShare, reactionShare, deltaDb — максимумы за событие
    def to_json(self) -> dict      # camelCase-ключи как в DetectorEvent (Task 2), плюс "type": "event"
@dataclass
class NearMiss: t_ms: int; kind: str; missing: list[str]; values: dict     # kind: 'chat' | 'audio'
class EventAssembler:
    def __init__(self, cfg: dict): ...
    def on_tick(self, now_ms: int, frame: ChatFrame, new_spikes: list[VoiceSpike],
                recent_spikes: Callable[[int, int], list[VoiceSpike]]) -> tuple[list[Event], list[NearMiss]]
    def flush(self) -> list[Event]         # закрыть открытое событие (конец эпохи / остановка)
    def set_epoch(self, epoch: int) -> None
```

Правила (значения — из конфигурации):
- **Смех:** `frame.warm` и `spike ≥ laughSpike` и `messages ≥ minMessages` и `authors ≥ minAuthors` и `laugh_share ≥ laughShare` и `repeat_class != 'interactive'`.
- **Массовая реакция:** `frame.warm` и `spike ≥ massSpike` и `messages ≥ massMinMessages` и `authors ≥ massMinAuthors` и `repeat_class != 'interactive'` и (`reaction_share ≥ massReactionShare` или есть голосовой всплеск в `[now − voiceWindowS, now]`); при `repeat_class == 'unknown'` голосовой всплеск обязателен.
- **Звук:** `VoiceSpike.strong`.
- Чатовое событие открыто, пока `spike ≥ endSpike`; `end_ms` — тик, где упало ниже. `estimated_event_ms` — начало самого раннего голосового всплеска в `[chat_start − lookbackS, chat_start]`; нет такого → `chat_start − chatLagS`, `uncertainty_ms = lookbackS·1000`, `confidence = 'low'`; есть → `uncertainty_ms = 2000`.
- Звуковое событие: `estimated_event_ms = start_ms = spike.start_ms`, `end_ms = spike.end_ms`, `uncertainty_ms = 1000`; если за событие не сработал ни один чатовый триггер — `confidence = 'low'` и `S` умножается на 0,7.
- `start_ms = max(0, estimated_event_ms)`.
- Событие выдаётся, когда после его `end_ms` прошло `mergeGapS` без новых триггеров; триггер раньше этого срока продлевает событие и добавляет свой тип. Событие длиннее `maxEventS` закрывается принудительно.
- При срабатывании чатового триггера вызывается колбэк пометки всплеска (передать `ChatAnalyzer.mark_spike` в конструктор как `on_chat_spike: Callable[[int], None]`).
- Оценка: `C = rarity`, `U = author_rarity`, `E = laugh_share`, `A = clip(max delta_db за событие / 20, 0, 1)` (берутся максимумы за событие); `S = 0,35C + 0,25E + 0,20U + 0,20A`.
- NearMiss: чат — `spike ≥ laughSpike` и минимум выполнен, но триггер не сработал (в `missing` — имена невыполненных условий: `laugh_share`, `interactive`, `mass_spike`, `voice`, `warm`); звук — обычный (не strong) всплеск без открытого события. Не чаще одного на вид за 10 с.

- [ ] **Step 1: Тесты** (помощник строит последовательность `ChatFrame` и `VoiceSpike` по секундам)

```python
def test_laugh_trigger_creates_event_with_audio_anchor():
    # фон, голосовой всплеск на t=100 с, всплеск чата со смехом 106–114 с
    # → 1 событие: triggers ['laugh'], estimated_event_ms 100_000, start_ms 100_000, end_ms 114_000,
    #   confidence 'normal', выдано на тике 124 с
def test_laugh_without_audio_uses_chat_lag_and_low_confidence():   # estimated = 106_000 − 8_000, uncertainty 20_000
def test_fast_chat_without_laughter_no_event_but_nearmiss():       # spike 4, laugh 0 → events [], NearMiss.missing содержит 'laugh_share'
def test_mass_reaction_without_laughter():                         # spike 7, 16 сообщений, 11 авторов, reaction_share 0.5 → ['mass']
def test_mass_with_unknown_repeat_needs_voice():                   # без всплеска → нет события; с всплеском → есть
def test_interactive_repeat_suppresses_both_triggers():
def test_strong_voice_spike_alone_is_low_confidence_audio_event():
def test_events_within_10s_merge_and_collect_triggers():           # ['laugh', 'audio']
def test_nothing_fires_during_warmup():
def test_event_longer_than_max_is_closed():
def test_score_formula():                                          # C=.8,E=.6,U=.5,A=.5 → S == 0.63
def test_flush_returns_open_event():
```
- [ ] **Step 2: FAIL → Step 3: Реализовать → Step 4: `python -m pytest tests -v` — PASS**
- [ ] **Step 5: Commit** `feat(detector): triggers, event assembly and ranking score`

---

### Task 7: Детектор — процесс: чат IRC, протокол stdin/stdout

**Files:**
- Create: `detector/hl_detector/irc.py`, `detector/hl_detector/protocol.py`, `detector/hl_detector/__main__.py`, `detector/README.md` (установка: `python -m venv .venv`, `pip install -e .[dev]`)
- Test: `detector/tests/test_irc.py`, `detector/tests/test_protocol.py`, `detector/tests/test_main.py`

**Interfaces — Produces (контракт с ядром, Task 8):**

Запуск: `python -m hl_detector --channel <login> --config <path.json> [--no-chat]`.

**stdin** — кадры: 1 байт тип, 4 байта длина (uint32 LE), затем тело.
- тип `0` — PCM s16le моно 16 кГц;
- тип `1` — JSON UTF-8: `{"type":"epoch","epoch":N}` (сброс звука, `EventAssembler.flush()` + `set_epoch`), `{"type":"stop"}` (flush и выход с кодом 0).

**stdout** — JSON-строки (UTF-8, `\n`, flush после каждой):
- `{"type":"event", …}` — `Event.to_json()`;
- `{"type":"signals","tMs":…,"chatSpike":…,"laughShare":…,"messages":…,"deltaDb":…,"vad":…,"warm":…}` — раз в секунду;
- `{"type":"nearmiss","tMs":…,"kind":…,"missing":[…],"values":{…}}`;
- `{"type":"status","chat":"connected"|"disconnected"}` — при смене;
- `{"type":"heartbeat"}` — раз в 5 с.

```python
# protocol.py
def read_frames(stream: BinaryIO) -> Iterator[tuple[int, bytes]]      # обрыв посреди кадра → StopIteration
def emit(obj: dict, out: TextIO) -> None
# irc.py
class ChatSource(Protocol):                                            # замена на EventSub во второй очереди
    async def messages(self) -> AsyncIterator[tuple[int, str, str]]   # (wall_ms, user_id, text)
def parse_privmsg(line: str) -> tuple[int, str, str] | None           # из тегов tmi-sent-ts и user-id; без тегов → время получения и ник
class TwitchIrc:                                                       # wss://irc-ws.chat.twitch.tv:443, NICK justinfan<5 цифр>, CAP REQ :twitch.tv/tags, JOIN #channel
    def __init__(self, channel: str, on_status: Callable[[str], None]): ...
    # отвечает PONG на PING; при обрыве — on_status('disconnected'), повтор через 1, 2, 5, 10, 30 с
```
Перевод времени чата: при получении каждого PCM-кадра `offset = wall_now_ms − audio_t_ms` (берётся минимум за эпоху); `t_ms сообщения = wall_ms − offset`. Сообщения до первого PCM-кадра отбрасываются. Основной цикл: тик раз в секунду звукового времени → `ChatAnalyzer.tick` → `EventAssembler.on_tick`.

- [ ] **Step 1: Тесты**

```python
def test_parse_privmsg_with_tags():       # '@tmi-sent-ts=1700000000123;user-id=42 :nick!nick@nick.tmi.twitch.tv PRIVMSG #chan :АХАХА привет' → (1700000000123, '42', 'АХАХА привет')
def test_parse_privmsg_ignores_other_commands_and_garbage():   # PING, USERNOTICE, '', b'\xff'.decode('utf-8','replace') → None
def test_read_frames_roundtrip_and_truncated_tail():
def test_main_emits_event_for_scripted_input():
    # запуск main(argv, stdin=BytesIO(кадры), stdout=StringIO(), chat=FakeChat([...]), vad=FakeVad, clock=fake):
    # 90 с тихой речи + скачок +16 дБ на 0,6 с + {"type":"stop"} → среди строк есть event с triggers ['audio'], последняя строка — не обрывок
def test_main_epoch_frame_resets_timeline():   # после {"type":"epoch","epoch":1} signals.tMs снова с ~0, событие несёт epoch 1
def test_chat_disconnect_is_reported_and_audio_still_works():   # FakeChat бросает ConnectionError → строка status disconnected, процесс жив
```
`main` принимает подменные `stdin`, `stdout`, `chat`, `vad`, `clock` аргументами — так тесты не трогают сеть и модель.

- [ ] **Step 2: FAIL → Step 3: Реализовать** (PCM читается в отдельном потоке, чат — asyncio в своём потоке, обмен через `queue.Queue`) **→ Step 4: `python -m pytest tests -v` — PASS**
- [ ] **Step 5: Ручная проверка:** `python -m hl_detector --channel <любой живой канал> --config ../config.example.json < NUL` на 20 с — в выводе `status connected` и `heartbeat`.
- [ ] **Step 6: Ранний замер нагрузки (спек §12, п. 1 — до того, как строить остальное).** Одноразовый скрипт `scripts/spike-load.mjs` (в репозиторий не коммитится): `streamlink --stdout … best | ffmpeg -i pipe:0 -map 0:a:0 -ac 1 -ar 16000 -f s16le pipe:1`, выход оборачивается в кадры типа 0 и подаётся в `python -m hl_detector` на живом канале. Запустить 1, 3 и 5 копий на 5 минут, записать загрузку CPU и память в `docs/smoke-checklist-service.md`. Если 5 копий занимают больше ~60 % CPU пилотной машины — остановиться и сообщить заказчику до Task 8: схема «процесс на эфир» под вопросом.
- [ ] **Step 7: Commit** `feat(detector): process entrypoint, twitch irc source and stdio protocol`

---

### Task 8: Ядро — управление процессом детектора

**Files:**
- Create: `src/service/detectorProcess.ts`
- Test: `tests/service/detectorProcess.test.ts`, `tests/service/fixtures/fakeDetector.mjs` (Node-скрипт, говорящий по протоколу Task 7: на кадр PCM считает байты, на `epoch` печатает `signals`, по аргументу `--crash-after N` выходит с кодом 1)

**Interfaces:**
- Consumes: протокол Task 7; `DetectorEvent` (Task 2); `DetectorConfig` (Task 3).
- Produces:
```ts
export interface DetectorSignals { tMs: number; chatSpike: number; laughShare: number; messages: number; deltaDb: number; vad: number; warm: boolean }
export interface DetectorHealth { running: boolean; chat: 'connected' | 'disconnected' | 'unknown'; restarts: number }
export interface DetectorProcessOptions {
  command: string; args: string[];            // по умолчанию: pythonPath, ['-m', 'hl_detector', '--channel', ch, '--config', file]
  cwd: string; heartbeatTimeoutMs?: number;   // 15000
  restartDelaysMs?: number[];                 // [1000, 2000, 5000, 10000, 30000]
  spawn?: typeof import('node:child_process').spawn;
}
export class DetectorProcess extends EventEmitter {   // 'event' (DetectorEvent), 'signals', 'nearmiss' (object), 'health' (DetectorHealth)
  constructor(opts: DetectorProcessOptions);
  start(): void;
  attachPcm(pcm: Readable, epoch: number): void;      // шлёт кадр epoch, затем PCM кадрами ≤ 64 КБ; предыдущий поток отвязывается
  health(): DetectorHealth;
  stop(): Promise<void>;                              // кадр stop, ждать выхода 3 с, затем kill
}
```
Если stdin детектора не успевает (backpressure) — PCM-кадры отбрасываются, а не копятся в памяти. После перезапуска процесса текущая эпоха объявляется заново и PCM продолжает идти.

- [ ] **Step 1: Тесты**

```ts
it('frames pcm and announces the epoch first', …);            // fakeDetector печатает полученные типы кадров: [1, 0, 0…]
it("emits 'event' for event lines and ignores malformed lines", …);
it('restarts a crashed detector and re-announces the current epoch', …);   // --crash-after 1; health().restarts === 1
it('restarts when heartbeats stop', …);                        // heartbeatTimeoutMs: 200
it('reports chat status changes through health', …);
it('stop() resolves even if the process ignores the stop frame', …);
it('fails softly when the command does not exist', …);         // command: 'no-such-python' → health.running false, без необработанных ошибок
```
- [ ] **Step 2: FAIL → Step 3: Реализовать → Step 4: `npx vitest run tests/service/detectorProcess.test.ts` — PASS**
- [ ] **Step 5: Commit** `feat: detector process supervisor`

---

### Task 9: Нарезчик

**Files:**
- Create: `src/service/cutter.ts`, `src/service/clipPaths.ts`
- Test: `tests/service/cutter.test.ts`, `tests/service/clipPaths.test.ts`

**Interfaces:**
- Consumes: `RingBufferManager` (`pin`, `unpin`, `select`, `latest`, событие `'segment'`), `concatSegments`/`ConcatFn` (`src/main/capture/concat.ts`), `createClipRepo`, `DetectorEvent`, `ServiceConfig`, `sessionFolderName` из `src/main/export/paths.ts`.
- Produces:
```ts
// clipPaths.ts
export function feedClipPaths(libraryDir: string, s: Pick<CaptureSession, 'streamer' | 'streamId' | 'startedAt'>, createdAt: Date, triggers: Trigger[], clipId: string): { dir: string; mp4Path: string; jsonPath: string };
//   <library>/<канал>/<streamId>_<дата>/<YYYY-MM-DD_HH-mm-ss>_<triggers через '+'>_<последние 4 hex id>.mp4 и .json
// cutter.ts
export interface CutterDeps {
  ring: RingBufferManager; clips: ReturnType<typeof createClipRepo>; config: () => ServiceConfig;
  session: () => CaptureSession; concat?: ConcatFn; freeBytes?: () => Promise<number>;   // по умолчанию fs.statfs(libraryDir)
  paused?: () => boolean;                    // пауза нарезки от Janitor (Task 12)
  now?: () => Date; newId?: () => string; sleep?: (ms: number) => Promise<void>; tailTimeoutMs?: number;   // 20000
}
export class Cutter extends EventEmitter {   // 'clip' (FeedClip) — при каждом изменении записи; 'paused' ({ reason: string })
  constructor(deps: CutterDeps);
  onEvent(ev: DetectorEvent): Promise<void>;
  manual(): Promise<Result<FeedClip>>;       // последние manualClipMs текущей эпохи, triggers ['manual'], score 0
  flush(): Promise<void>;                    // дождаться всех начатых клипов, не дожидаясь хвоста (режется то, что есть)
}
```
Алгоритм `onEvent`: диапазон `[startMs − preRoll, endMs + postRollMs]`, где `preRoll = confidence === 'low' && !triggers.includes('audio') ? preRollLowConfidenceMs : preRollMs`; обрезать до `maxClipMs` от начала; вставить запись `pending`; `ring.pin(clipId, epoch, from, to)`; ждать, пока `ring.latest(epoch).endMs ≥ to` (или `tailTimeoutMs`, или `flush`); `ring.select`; склейка в `<mp4>.part` → rename; `clip.json` (все поля `FeedClip` + `DetectorEvent` + `configVersion`: sha1 от JSON `config().detector`); запись → `new`; `unpin`. До 3 попыток склейки с паузой 1 с; затем `error` с текстом последней ошибки, `.part` удаляется.

Ограничитель шума (перед вставкой записи): если `clips.countSince(sessionId, час назад) ≥ maxClipsPerHour` и `ev.scores.S ≤ медиана(clips.scoresSince(...))` — событие отбрасывается (ручные клипы не ограничиваются). Пауза: `paused()` или `freeBytes() < diskReserveBytes` → событие отбрасывается, `emit('paused', …)`.

- [ ] **Step 1: Тесты** (буфер наполняется сегментами-заглушками; `concat` подменён функцией, пишущей список путей в выходной файл)

```ts
it('cuts [start−15s, end+10s] after the tail segments arrive', …);          // событие 100_000–110_000 → select вернул сегменты 84–120 с; клип 'pending' → 'new'
it('uses the 30 s pre-roll for a low-confidence chat event', …);
it('keeps 15 s for a low-confidence audio-only event', …);
it('caps the clip at maxClipMs', …);
it('writes clip.json next to the mp4 with event fields and configVersion', …);
it('unpins the range after success and after failure', …);
it('retries concat 3 times, then marks the clip as error and removes the .part file', …);   // Review Focus 4
it('marks the clip as error when the epoch has no segments left', …);        // Review Focus 1: событие из эпохи 0, в буфере только эпоха 1
it('cuts what exists when the event starts before the oldest segment', …);   // Review Focus 1
it('drops events over the hourly limit unless the score beats the median', …);
it('drops events and emits paused when free space is below the reserve', …);
it('flush() cuts pending clips with the tail that exists', …);
it('manual() cuts the last 60 s of the current epoch', …);
it.skipIf(!hasFfmpeg)('produces a playable mp4 from real ts segments without re-encoding', …);   // synthVideo → сегменты; ffprobe: кодек видео тот же, длительность ±2.5 с
```
- [ ] **Step 2: FAIL → Step 3: Реализовать → Step 4: `npx vitest run tests/service` — PASS**
- [ ] **Step 5: Commit** `feat: clip cutter with adaptive pre-roll, noise limiter and disk guard`

---

### Task 10: Реестр эфиров

**Files:**
- Create: `src/service/streams.ts`, `src/service/nearMissLog.ts`
- Test: `tests/service/streams.test.ts`

**Interfaces:**
- Consumes: `CaptureSessionManager`, `RingBufferManager`, `createProcessRunner` (Task 1); `DetectorProcess` (Task 8); `Cutter` (Task 9); `createRepos(db).sessions/segments`; `ServiceConfig`, `saveConfigPatch` (Task 3).
- Produces:
```ts
export interface StreamStatus {
  id: string; channel: string; quality: string; state: CaptureState; error?: string;
  startedAt: string; bufferedMs: number; clipsCreated: number;
  detector: DetectorHealth; signals: DetectorSignals | null;
}
export interface StreamRegistryDeps {
  db: Db; config: () => ServiceConfig; configFile: string; cuttingPaused: () => boolean;
  runner?: ProcessRunner; makeDetector?: (channel: string) => DetectorProcess; concat?: ConcatFn;
}
export class StreamRegistry extends EventEmitter {    // 'streams' (StreamStatus[]), 'clip' (FeedClip), 'notice' ({ level, message })
  constructor(deps: StreamRegistryDeps);
  probe(url: string): Promise<Result<{ channel: string; qualities: string[] }>>;
  start(url: string, quality: string): Promise<Result<StreamStatus>>;
  stop(id: string): Promise<void>;
  manualClip(id: string): Promise<Result<FeedClip>>;
  list(): StreamStatus[];
  mode(): { multiStream: boolean; limit: number };
  setMultiStream(on: boolean): Result<null>;
  shutdown(): Promise<void>;
}
// nearMissLog.ts
export function appendNearMiss(dataDir: string, channel: string, entry: object): void;   // <dataDir>/nearmiss/<канал>/<YYYY-MM-DD>.jsonl, запись + '\n'
```
Правила: лимит — 1 при `multiStream: false`, иначе `maxStreams`. Тексты ошибок: `Это не ссылка на канал Twitch`, `Канал не в эфире`, `Этот канал уже записывается`, `Достигнут лимит одновременных эфиров (N). Остановите один из эфиров или включите режим «несколько эфиров»`, `Сначала остановите лишние эфиры: в режиме «один эфир» может идти только один`. `setMultiStream` сохраняет значение в файл конфигурации. Буфер эфира — `<bufferDir>/<sessionId>`; у каждого эфира свой `RingBufferManager` (`retentionMs = bufferSeconds·1000`, `maxPinnedBytes` 2 ГБ) и запись сегментов в общую таблицу через `repos.segments` (`clear()` при старте сервиса, а не эфира — заменить вызов в `doStop` удалением по `sessionId`: добавить `segments.clearSession(sessionId)` в `repos.ts` и использовать его в `RingBufferManager.clearAll` через новый необязательный параметр `sessionId` в `RingBufferOptions`).

Связи внутри эфира: `'epoch'` → `detector.attachPcm(pcm, epoch)`; `detector 'event'` → `cutter.onEvent`; `'nearmiss'` → `appendNearMiss`; `beforeStop` → `cutter.flush()` затем `detector.stop()`; `'ended'` → notice `Эфир <канал> завершился` и удаление из реестра; статус рассылается не чаще раза в секунду.

- [ ] **Step 1: Тесты** (подменные runner и detector)

```ts
it('rejects a second stream in single mode with the limit message', …);
it('runs up to maxStreams in multi mode, each with its own buffer directory', …);
it('refuses to leave multi mode while two streams are running', …);
it('persists the mode to the config file', …);
it('rejects a duplicate channel', …);
it('routes a detector event of stream A only to the cutter of stream A', …);
it('re-attaches pcm to the detector on reconnect with the new epoch', …);
it('flushes pending clips before the buffer is cleared on stop', …);
it("removes the stream and emits a notice on 'ended'", …);
it('stopping one stream leaves the segments of the other in the table', …);
it('writes near-misses to the jsonl log', …);
```
- [ ] **Step 2: FAIL → Step 3: Реализовать → Step 4: `npx vitest run` — PASS (включая старые тесты ringBuffer)**
- [ ] **Step 5: Commit** `feat: multi-stream registry with single/multi mode`

---

### Task 11: HTTP API, вход по паролю, раздача клипов

**Files:**
- Create: `src/service/http.ts`, `src/service/auth.ts`
- Modify: `src/main/server.ts` (экспортировать `sendFile`, `parseRange`, `end`, `MIME`; поведение не менять)
- Test: `tests/service/http.test.ts`, `tests/service/auth.test.ts`

**Interfaces:**
- Consumes: `StreamRegistry` (Task 10), `createClipRepo` (Task 2), `ServiceConfig`.
- Produces:
```ts
// auth.ts
export class Sessions {                                  // в памяти; токен — 32 случайных байта hex; срок 30 дней
  constructor(password: string, now?: () => number);
  login(password: string): string | null;                // сравнение через timingSafeEqual по sha256
  valid(token: string | undefined): boolean;
  logout(token: string): void;
}
// http.ts
export interface HttpDeps { registry: StreamRegistry; clips: ReturnType<typeof createClipRepo>; config: () => ServiceConfig; webDir: string; cuttingPaused: () => { paused: boolean; reason: string | null } }
export function startHttp(deps: HttpDeps, port: number, host?: string): Promise<{ port: number; close(): Promise<void>; broadcast(event: string, data: unknown): void }>;   // host по умолчанию '0.0.0.0'
```

| Метод и путь | Тело / параметры | Ответ |
| --- | --- | --- |
| `POST /api/login` | `{ password }` | 204 + cookie `hl_session` (HttpOnly, SameSite=Strict, Path=/); неверный → 401 `{ error: 'Неверный пароль' }`; 5 неудач с одного адреса за минуту → 429 |
| `POST /api/logout` | | 204 |
| `GET /api/state` | | `{ streams: StreamStatus[], mode: { multiStream, limit }, cutting: { paused, reason } }` |
| `POST /api/probe` | `{ url }` | `{ channel, qualities }` или 400 `{ error }` |
| `POST /api/streams` | `{ url, quality }` | 201 `StreamStatus` или 400/409 `{ error }` |
| `DELETE /api/streams/:id` | | 204 |
| `POST /api/streams/:id/manual-clip` | | 201 `FeedClip` или 400 `{ error }` |
| `PUT /api/mode` | `{ multiStream }` | 200 `{ multiStream, limit }` или 409 `{ error }` |
| `GET /api/clips` | `?streamer=&status=&limit=` | `FeedClip[]` без полей `mp4Path`, `jsonPath` |
| `POST /api/clips/:id/status` | `{ status: 'new' \| 'taken' \| 'rejected' }` | 200 `FeedClip`; для `pending`/`error` → 409 |
| `GET /media/clips/:id.mp4` | `?download=1` | файл с Range; с `download` — `Content-Disposition: attachment; filename="<имя файла>"`; `fileDeleted` или файла нет → 404 |
| `GET /api/events` | | SSE: события `streams`, `clip`, `notice`, `cutting`; комментарий-пинг раз в 20 с |
| прочее `GET` | | статика из `webDir`, SPA-fallback на `index.html` |

Всё, кроме `POST /api/login` и статики, без действительной cookie → 401. Запросы с телом: только `Content-Type: application/json`, тело ≤ 64 КБ, иначе 415/413. Для изменяющих методов заголовок `Origin`, если есть, должен совпадать с `Host` → иначе 403. CSP для HTML: `default-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self'; object-src 'none'; base-uri 'none'`. Проверка `Host === localhost` из старого сервера **не** переносится (доступ по сети — требование).

- [ ] **Step 1: Тесты `auth.test.ts`** — верный пароль даёт токен, неверный `null`; токен истекает через 30 дней; `logout` отзывает.
- [ ] **Step 2: Тесты `http.test.ts`** (реальный сервер на порту 0, подменный registry, клипы во временной папке)

```ts
it('rejects api calls without a session cookie with 401', …);
it('logs in with the password and sets an HttpOnly cookie', …);
it('rate-limits repeated wrong passwords', …);
it('returns a Russian error for a non-twitch link, a VOD link, an empty string and an offline channel', …);   // Review Focus 3
it('starts a stream and reports 409 with the limit message', …);
it('lists clips without file system paths', …);
it('changes a clip status and stores statusChangedAt; concurrent changes both succeed, last one wins', …);     // Review Focus 5
it('refuses to change the status of a pending or error clip', …);
it('serves a clip with Range support and as an attachment when download=1', …);
it('returns 404 for the media of a clip whose file was deleted', …);                                           // Review Focus 5
it('rejects cross-origin state-changing requests', …);
it('pushes clip and streams updates over SSE', …);
it('does not serve files outside webDir', …);                                                                 // /../../config.json → 403/404
```
- [ ] **Step 3: FAIL → Step 4: Реализовать → Step 5: `npx vitest run tests/service` — PASS**
- [ ] **Step 6: Commit** `feat: http api with password login, feed endpoints and sse`

---

### Task 12: Уборка диска

**Files:**
- Create: `src/service/janitor.ts`
- Test: `tests/service/janitor.test.ts`

**Interfaces — Produces:**
```ts
export class Janitor extends EventEmitter {       // 'cutting' ({ paused: boolean; reason: string | null }), 'clip' (FeedClip)
  constructor(deps: { clips: ReturnType<typeof createClipRepo>; config: () => ServiceConfig; freeBytes?: () => Promise<number>; unlink?: (p: string) => Promise<void>; now?: () => Date });
  run(): Promise<void>;                           // один проход
  start(intervalMs?: number): void;               // 60000
  stop(): void;
  state(): { paused: boolean; reason: string | null };
}
```
Проход: (1) у отклонённых клипов старше `rejectedTtlHours` удалить MP4, выставить `fileDeleted` (запись и `.json` остаются); (2) если свободно меньше `diskReserveBytes` — удалить MP4 всех отклонённых сразу, перепроверить; всё ещё меньше → `paused: true`, причина `Мало места на диске: нарезка новых клипов приостановлена, запись эфиров продолжается`; (3) места стало достаточно → `paused: false`. Клипы `new`, `taken`, `pending` не трогаются никогда. `Cutter.paused` и `HttpDeps.cuttingPaused` получают `janitor.state()`.

- [ ] **Step 1: Тесты**

```ts
it('deletes the mp4 of clips rejected more than 24 h ago and keeps the row and the json', …);
it('keeps recently rejected clips while there is enough space', …);
it('deletes all rejected files at once when space is below the reserve', …);
it('pauses cutting when deleting rejected files is not enough, and resumes when space returns', …);   // Review Focus 4
it('never deletes new, taken or pending clips', …);
it('survives a file that is already gone', …);
```
- [ ] **Step 2: FAIL → Step 3: Реализовать → Step 4: PASS**
- [ ] **Step 5: Commit** `feat: disk janitor for rejected clips and reserve guard`

---

### Task 13: Веб-интерфейс

**Files:**
- Create: `vite.web.config.ts` (root `src/web`, outDir `out/web`, alias `@shared`, dev-proxy `/api` и `/media` на `http://localhost:8080`), `src/web/index.html`, `src/web/main.tsx`, `src/web/api.ts`, `src/web/App.tsx`, `src/web/views/Login.tsx`, `src/web/views/Streams.tsx`, `src/web/views/Feed.tsx`, `src/web/components/ClipCard.tsx`, `src/web/components/StreamCard.tsx`, `src/web/format.ts`, `src/web/styles.css`
- Modify: `package.json` (scripts: `"web:build": "vite build --config vite.web.config.ts"`, `"web:dev": "vite --config vite.web.config.ts"`)
- Test: `tests/web/format.test.ts`, `tests/web/ClipCard.test.tsx`, `tests/web/Streams.test.tsx`

**Interfaces:**
- Consumes: API из Task 11; типы `FeedClip`, `StreamStatus`, `Trigger` (импорт типов из `src/service/types.ts` и `src/service/streams.ts` — только `import type`).
- Produces:
```ts
// api.ts — все функции бросают ApiError { status, message } (message — поле error ответа)
export const api = { login, logout, state, probe, startStream, stopStream, manualClip, setMode, clips, setClipStatus };
export function subscribe(handlers: { streams?, clip?, notice?, cutting?, unauthorized? }): () => void;   // EventSource('/api/events'), автопереподключение
// format.ts
export function triggerLabel(t: Trigger): string;        // laugh → 'смех', mass → 'массовая реакция', audio → 'звук', manual → 'вручную'
export function clipSummary(c: FeedClip): string;        // 'чат ×5,2 · смех 61 % · звук +14 дБ' — части с нулевым значением опускаются
export function duration(ms: number): string;            // 38000 → '38 с', 95000 → '1 мин 35 с'
```

Экраны (русский интерфейс, без роутера — три состояния `App`: вход / «Эфиры» / «Лента», переключатель вкладок сверху):
- **Вход:** поле пароля, кнопка «Войти», текст ошибки от API.
- **Эфиры:** поле ссылки → «Проверить» (`probe`) → выпадающий список качеств (по умолчанию `best`) → «Начать». Переключатель «Несколько эфиров»; при включении — `confirm` с текстом `Режим «несколько эфиров» записывает до 5 эфиров одновременно и заметно сильнее нагружает процессор, диск и сеть. Включить?`. Карточка эфира: канал, состояние по-русски (`CONNECTING` → «подключение», `RECORDING` → «запись», `RECONNECTING` → «переподключение», `STOPPING` → «остановка», `ERROR` → текст ошибки), буфер в секундах, полоски «чат» (`chatSpike`, шкала 0–8) и «звук» (`deltaDb`, шкала 0–20), число клипов, пометки `детектор не работает` (`!detector.running`) и `нет чата` (`detector.chat === 'disconnected'`), кнопки «Остановить» и «Сохранить последние 60 с». Баннер на всю ширину при `cutting.paused` с текстом причины.
- **Лента:** фильтры «канал» (из клипов), «статус» (все / новые / взятые / отклонённые), сортировка «по времени» / «по оценке». Карточка:

  ```
  [<video controls preload="none">]  channel · 19:42 · 38 с · смех + звук · S 0,74   [низкая уверенность]
                                     чат ×5,2 · смех 61 % · звук +14 дБ
                                     [Беру] [Отклонить] [Скачать]                      новый
  ```
  `pending` — «нарезается…» без видео и кнопок; `error` — текст ошибки; `fileDeleted` — «файл удалён» без видео и «Скачать». Нажатый статус можно снять повторным нажатием (возврат в `new`). Новые клипы приходят по SSE и встают сверху без перезагрузки.

Оформление — на усмотрение исполнителя в этих рамках: тёмная тема, одна колонка на телефоне.

- [ ] **Step 1: Тесты** (jsdom, как `tests/renderer/*`)

```ts
// format.test.ts
expect(clipSummary({ signals: { chatSpike: 5.2, laughShare: 0.61, reactionShare: 0, deltaDb: 14 } } as FeedClip)).toBe('чат ×5,2 · смех 61 % · звук +14 дБ');
expect(duration(95000)).toBe('1 мин 35 с');
// ClipCard.test.tsx
it('shows the preview, both triggers and the low-confidence badge', …);
it('calls setClipStatus("taken") on «Беру» and back to "new" on a second click', …);
it('shows «нарезается…» without a video for a pending clip', …);
it('shows «файл удалён» and no download link for a deleted file', …);
// Streams.test.tsx
it('asks for confirmation with the resource warning before enabling multi mode', …);
it('shows the api error text when start fails', …);
it('marks a stream whose detector is down', …);
```
- [ ] **Step 2: FAIL → Step 3: Реализовать → Step 4: `npx vitest run tests/web` и `npm run web:build` — PASS, `out/web/index.html` существует**
- [ ] **Step 5: Commit** `feat: web ui with streams and feed`

---

### Task 14: Точка входа, запуск, замеры на живом эфире

**Files:**
- Create: `src/service/main.ts`, `scripts/sync-check.md` (порядок замера ниже), `docs/smoke-checklist-service.md`
- Modify: `package.json` (devDependency `tsx`; scripts: `"service": "tsx src/service/main.ts"`, `"service:build": "npm run web:build"`), `README.md` (раздел «Сервис»: установка Python-окружения детектора, `config.json`, запуск, адрес `http://<ip>:8080`, туннель для удалённого доступа — одной строкой), `.gitignore` (`data/`, `detector/.venv/`, `config.json`)
- Test: `tests/service/main.test.ts`

**Interfaces:**
- Consumes: всё из Task 2–13.
- Produces: `export async function runService(opts: { configFile: string; dataDir: string; overrides?: Partial<StreamRegistryDeps> }): Promise<{ port: number; shutdown(): Promise<void> }>` и запуск при прямом вызове: `HL_CONFIG` (по умолчанию `./config.json`), `HL_DATA` (по умолчанию `./data`).

Порядок старта: загрузить конфигурацию (нет файла → создать из умолчаний со случайным паролем из 16 символов и напечатать его один раз в консоль) → открыть БД `<dataDir>/service.sqlite` → `clips.failPending('Сервис был перезапущен до завершения нарезки')` → очистить `bufferDir` и таблицу сегментов → Janitor → StreamRegistry → HTTP → напечатать `Сервис запущен: http://localhost:<port>`. События `registry 'clip' | 'streams' | 'notice'` и `janitor 'cutting' | 'clip'` → `broadcast`. SIGINT/SIGTERM → `registry.shutdown()` (flush клипов), остановка Janitor, HTTP, БД.

- [ ] **Step 1: Тест `main.test.ts`** (подменные runner/detector)

```ts
it('creates a config with a generated password on first run', …);
it('marks clips left pending by a previous run as error', …);
it('end to end: login → start stream → detector event → clip appears in /api/clips as new → media is served', …);
it('shutdown flushes a pending clip before exit', …);
```
- [ ] **Step 2: FAIL → Step 3: Реализовать → Step 4: `npx vitest run && npm run typecheck && cd detector && python -m pytest` — всё PASS**
- [ ] **Step 5: Живой прогон по `docs/smoke-checklist-service.md`** (записать результаты в файл):
  1. `npm run service`, вход, запуск одного живого эфира с качеством `best`; через 2 минуты — «Сохранить последние 60 с»; клип проигрывается в ленте и скачивается; `ffprobe` показывает исходное разрешение и кодек.
  2. **Синхронизация (спек §11):** найти в клипе с триггером `audio` или `manual` резкий звук; сравнить его время в MP4 с `estimatedEventMs − (startMs клипа)` из `clip.json`. Повторить после 30 минут записи и после принудительного обрыва сети на 20 с. Расхождение > 1,5 с или рост со временем — завести задачу на привязку детектора к меткам времени потока и не считать пилот готовым.
  3. **Нагрузка:** загрузка CPU и памяти при 1, 3 и 5 эфирах (режим «несколько эфиров») — на пилотной машине и на машине с GTX 1050 Ti; задержка «конец момента → клип в ленте» ≤ 30 с.
  4. Выдернуть сеть на 20 с — эфир переподключается, детектор продолжает работу в новой эпохе. Убить процесс `python` — он перезапускается, запись не прерывается.
  5. 30 минут на активном русскоязычном канале: посчитать клипы, отметить «взят/отклонён», посмотреть `data/nearmiss/` — зафиксировать числа как исходную точку для подбора порогов.
- [ ] **Step 6: Commit** `feat: service entrypoint, docs and smoke checklist`

