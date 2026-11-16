# Относительный триггер по чату и оценка 1–10 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить триггеры детектора («смех», «массовая реакция», независимый «звук») одним правилом — доля активных в чате, написавших смех или реакцию, — и оценкой клипа 1–10.

**Architecture:** `ChatAnalyzer` считает в окне триггерные сообщения, их авторов и активных авторов за 300 с; `EventAssembler` срабатывает по этим числам и считает оценку из трёх слагаемых (доля, скорость, звук). Node и веб-лента переходят с `scores.S` (0…1) на `scores.total` (1–10) и новые метки. Протокол stdin/stdout, нарезка, R8 не меняются.

**Tech Stack:** Python 3.10 (детектор, pytest), TypeScript/Node (сервис, Vitest), React (лента).

**Spec:** `docs/superpowers/specs/2026-11-16-relative-chat-trigger-design.md`

## Global Constraints

- Звук без реакции чата никогда не создаёт событие.
- Меньше 3 триггерных сообщений в окне — события нет никогда.
- Триггерные сообщения — смех **и** реакции (`laughWords` + `reactionWords`); интерактив (`interactiveWords`) триггером не является.
- Все числа — в конфигурации; значения по умолчанию ниже взяты из спека дословно. Python `DEFAULTS` зеркалит `defaultConfig().detector` из TS ключ в ключ.
- Устаревшие ключи в пользовательском `config.json` (`laughSpike`, `mass*`, `weights` …) игнорируются, а не дают ошибку (TS `merge` уже обходит только ключи умолчаний — сохранить это; Python `load_config` — так же).
- Все тексты интерфейса — на русском. Видео не перекодируется.
- Коммит после каждой задачи; сообщения `feat: …`/`fix: …`, в конце `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Один спамер на маленьком канале** («ахах» ×5 от одного автора, активных 3) → события нет (`minTriggerAuthors` 2). Тест: Task 2.
2. **Почти пустой чат** (активных 2, два автора пишут по 2 «хаха») → доля считается от `minActive` 10, а не от 2. Тест: Task 1.
3. **Сильный всплеск голоса без единого триггерного сообщения** → нет события и нет клипа (раньше был `audio`). Тест: Task 2.
4. **Старые клипы в базе** (`triggers: ["mass"]`, `signals` без `triggerShare`, оценка 0…1) → лента их показывает без падения: «реакция», без несуществующих частей сводки. Тест: Task 3.
5. **Старый `config.json` с удалёнными ключами** → сервис и детектор запускаются, ключи молча игнорируются. Тест: Task 1.

---

### Task 1: Конфигурация и признаки чата

**Files:**
- Modify: `src/service/config.ts` (`DetectorConfig`, `defaultConfig`), `config.example.json`, `detector/hl_detector/config.py` (`DEFAULTS`), `detector/hl_detector/chat.py` (`ChatFrame`, `ChatAnalyzer.tick`)
- Test: `tests/service/config.test.ts`, `detector/tests/test_chat.py`, `detector/tests/test_config.py` (создать, если нет)

**Interfaces — Produces:**

Новый `detector` (числа — значения по умолчанию, тип `number`):
```ts
chat: { windowS: 5; baselineS: 300; alpha: 1; activeWindowS: 300; minActive: 10;
        minTriggerMessages: 3; minTriggerAuthors: 2; minTriggerShare: 0.05; endSpike: 1.5; repeatShare: 0.6;
        laughWords: string[]; reactionWords: string[]; interactiveWords: string[] };   // списки слов без изменений
audio: { … без изменений … };
events: { warmupS: 60; lookbackS: 20; chatLagS: 8; voiceWindowS: 20; mergeGapS: 10; maxEventS: 60 };
score: { shareFull: 0.3; spikeFull: 6; audioMinDb: 10; audioFullDb: 20 };
```
В этой задаче новые ключи только **добавляются** (TS и Python). Старые — `chat.minMessages`, `chat.minAuthors`, `chat.laughSpike`, `chat.laughShare`, `chat.massSpike`, `chat.massMinMessages`, `chat.massMinAuthors`, `chat.massReactionShare`, весь `weights` — удаляет Task 2 вместе с кодом, который их читает. Ключи `audio.trigger*` остаются навсегда: они нужны `VoiceSpike.strong`, который просто перестаёт быть триггером.

```python
@dataclass
class ChatFrame:                 # существующие поля остаются; добавляются:
    trigger_messages: int        # сообщений в окне, где хотя бы один токен — смех или реакция
    trigger_authors: int         # разных авторов этих сообщений
    laugh_messages: int          # из них со смехом
    reaction_messages: int       # из них с реакцией (без смеха)
    active_authors: int          # max(minActive, разных авторов за activeWindowS до now включительно)
    trigger_share: float         # trigger_authors / active_authors
```

- [ ] **Step 1: Тесты**

```python
def test_trigger_counts_laugh_and_reaction():        # окно: 'ахах','KEKW','НЕЕЕТ','wtf','привет','1' от 6 авторов
    # → trigger_messages 4, laugh_messages 2, reaction_messages 2, trigger_authors 4
def test_active_authors_over_300s():                 # 30 разных авторов писали за последние 300 с, 5 — 310 с назад
    # → active_authors == 30; trigger_share == trigger_authors / 30
def test_active_authors_floor():                     # активных 2, оба написали 'хаха' дважды → active_authors 10, trigger_share 0.2
def test_one_author_counts_once():                   # 5×'ахах' от одного автора → trigger_messages 5, trigger_authors 1
def test_interactive_is_not_trigger():               # 10×'1' → trigger_messages 0
```
```python
def test_load_config_ignores_unknown_keys(tmp_path):  # {"detector":{"chat":{"someOldKey":3}},"password":"x"} → без ошибки, ключа нет в результате
def test_defaults_have_new_keys():                    # DEFAULTS["chat"]["minTriggerShare"] == 0.05, DEFAULTS["score"]["spikeFull"] == 6
```
```ts
it('ignores unknown detector keys', …);               // { password:'x', detector:{ chat:{ someOldKey: 3 }, oldSection:{C:1} } } → ok, cfg.detector.chat.minTriggerShare === 0.05
it('has the new score defaults', …);                  // defaultConfig('D:/d').detector.score → { shareFull: 0.3, spikeFull: 6, audioMinDb: 10, audioFullDb: 20 }
```
- [ ] **Step 2: Запустить** `detector/.venv/Scripts/python -m pytest detector/tests/test_chat.py detector/tests/test_config.py` и `npx vitest run tests/service/config.test.ts` — **FAIL**
- [ ] **Step 3: Реализовать.** Сообщение — триггерное, если `classify` хотя бы одного токена даёт `laugh` или `reaction`; смех имеет приоритет при подсчёте `laugh_messages`/`reaction_messages`. Активные авторы — отдельная очередь `(t_ms, user)` за `activeWindowS`. `config.example.json` — новый `detector` целиком. Старые тесты chat, опиравшиеся на удалённые ключи, поправить.
- [ ] **Step 4: PASS** обе команды, весь `python -m pytest detector/tests` и `npm run typecheck` — без ошибок
- [ ] **Step 5: Commit** `feat(detector): trigger messages and active chatters in chat features`

---

### Task 2: Правило срабатывания и оценка 1–10

**Files:**
- Modify: `detector/hl_detector/events.py`, `detector/hl_detector/__main__.py` (строки `signals`)
- Test: `detector/tests/test_events.py` (переписать под новое правило), `detector/tests/test_main.py`

**Interfaces:**
- Consumes: `ChatFrame` (Task 1), `VoiceSpike.delta_db`, `recent_spikes`.
- Produces — `Event.to_json()`:
```
{ type:'event', epoch, startMs, endMs, triggerTimeMs, estimatedEventMs, uncertaintyMs,
  triggers: ('laugh'|'reaction'|'audio')[], confidence: 'normal'|'low',
  scores: { total, share, speed, audio },          // total 1..10, слагаемые как в спеке, всё до 0,1
  signals: { chatSpike, triggerShare, triggerMessages, activeAuthors, laughShare, reactionShare, deltaDb } }   // максимумы за событие
```
- `signals`-строка stdout добавляет `triggerShare`, `triggerMessages`, `activeAuthors` (остальные поля как были).

Правило (все числа из `cfg`):
- Срабатывание на тике: прогрето (`warmupS` и `frame.warm`), `trigger_messages ≥ minTriggerMessages`, `trigger_authors ≥ minTriggerAuthors`, `trigger_share ≥ minTriggerShare`.
- Событие открыто, пока срабатывание держится или `frame.spike ≥ endSpike`; закрытие, слияние (`mergeGapS`), `maxEventS`, привязка `estimated_event_ms` к голосовому всплеску в `[chat_start − lookbackS, chat_start]` и `confidence` — как сейчас для чатового события.
- Независимый звуковой триггер удаляется; звуковые события не создаются вовсе.
- `triggers`: `laugh`, если за событие `sum(laugh_messages) ≥ sum(reaction_messages)`, иначе `reaction`; плюс `audio`, если `scores.audio > 0`.
- Оценка (максимумы за событие; `lin(x, a, b, top) = clip((x − a)/(b − a), 0, 1) · top`):
  `share = lin(trigger_share, minTriggerShare, shareFull, 5)`, `speed = lin(spike, 1, spikeFull, 3)`,
  `audio = lin(max delta_db голосовых всплесков в [start_ms − voiceWindowS, end_ms], audioMinDb, audioFullDb, 1)`,
  `total = min(10, 1 + share + speed + audio)`.
- Почти-срабатывание (`kind 'chat'`): `trigger_messages ≥ minTriggerMessages`, но нет срабатывания; `missing` ⊂ `['warm','authors','share']`. Звуковые почти-срабатывания убрать. Частота — не чаще раза в 10 с, как сейчас.

- [ ] **Step 1: Тесты** (помощник строит `ChatFrame` по секундам)

```python
def test_trigger_fires_on_share_and_three_messages():   # active 40, 4 сообщения от 3 авторов (7,5 %), spike 1 → 1 событие, triggers ['laugh'], scores.total ≈ 1.3 (share 0,3), speed 0
def test_below_three_messages_no_event():               # 2 сообщения от 2 авторов, share 0.5 → нет события, nearmiss нет
def test_one_spammer_no_event():                        # 5 сообщений от 1 автора → нет события, nearmiss.missing == ['authors']
def test_low_share_no_event_but_nearmiss():             # active 200, 4 автора (2 %) → нет события, missing == ['share']
def test_reaction_dominant_label():                     # 'НЕЕЕТ'×4,'ахах'×1 → triggers ['reaction']
def test_voice_spike_alone_never_fires():               # strong VoiceSpike +20 дБ, чат пуст → events []
def test_audio_adds_points_and_label():                 # срабатывание + всплеск +15 дБ за 5 с до → scores.audio == 0.5, 'audio' in triggers, estimated_event_ms == всплеск.start_ms, confidence 'normal'
def test_score_example_from_spec():                     # share 0.10, spike 4, delta_db 15 → share 1.0, speed 1.8, audio 0.5, total 4.3
def test_score_caps_at_10():                            # share 0.6, spike 9, delta_db 25 → total == 10
def test_nothing_fires_during_warmup():
def test_events_merge_within_gap():
def test_event_longer_than_max_is_closed():
```
```python
def test_main_signals_line_has_trigger_fields():       # в строке signals есть triggerShare, triggerMessages, activeAuthors
```
- [ ] **Step 2: `python -m pytest detector/tests` — FAIL**
- [ ] **Step 3: Реализовать**; удалить из `events.py` код «mass» и звуковых событий; удалить старые ключи (список в Task 1) из Python `DEFAULTS`, `src/service/config.ts` (`DetectorConfig`, `defaultConfig`) и `config.example.json`; добавить тест `test_load_config_ignores_removed_keys` с `{"detector":{"chat":{"laughSpike":3},"weights":{"C":1}}}` и TS-тест `loads a config with removed detector keys` с теми же ключами. Прогнать также `npx vitest run tests/service/config.test.ts` и `npm run typecheck`.
- [ ] **Step 4: `python -m pytest detector/tests` — PASS**
- [ ] **Step 5: Commit** `feat(detector): relative chat trigger and 1-10 score`

---

### Task 3: Сервис и лента на новой оценке

**Files:**
- Modify: `src/service/types.ts`, `src/service/cutter.ts`, `src/web/format.ts`, `src/web/components/ClipCard.tsx`, `src/web/components/StreamCard.tsx` (если читает удалённые поля), фикстуры тестов (`tests/service/fixtures/fakeDetector.mjs`, события в тестах cutter/streams/http/main)
- Test: `tests/web/format.test.ts`, `tests/web/ClipCard.test.tsx`, `tests/service/cutter.test.ts`

**Interfaces:**
- Consumes: JSON события из Task 2.
- Produces:
```ts
export type Trigger = 'laugh' | 'reaction' | 'audio' | 'manual' | 'mass';   // 'mass' — только у старых записей
DetectorEvent.scores: { total: number; share: number; speed: number; audio: number };
DetectorEvent.signals: { chatSpike: number; triggerShare?: number; triggerMessages?: number; activeAuthors?: number;
                         laughShare: number; reactionShare: number; deltaDb: number };   // ? — у старых клипов полей нет
```
- `FeedClip.score = ev.scores.total`; ручной клип — `scores { total: 0, share: 0, speed: 0, audio: 0 }`, `score 0`. Часовой ограничитель сравнивает `ev.scores.total` с медианой.
- Лента: `triggerLabel` — `laugh 'смех'`, `reaction 'реакция'`, `mass 'реакция'`, `audio 'звук'`, `manual 'вручную'`. Карточка: `… · смех + звук · оценка 4,3` (вместо `S 0,74`); для `manual` оценка не показывается. Сводка: `чат ×4 · реакция 10 % активных · звук +15 дБ` — часть «N % активных» из `triggerShare`, только если поле есть; если его нет (старый клип) — прежние части `смех N %`/`реакция N %`.

- [ ] **Step 1: Тесты**

```ts
expect(triggerLabel('reaction')).toBe('реакция');
expect(triggerLabel('mass')).toBe('реакция');
expect(clipSummary({ signals: { chatSpike: 4, triggerShare: 0.1, triggerMessages: 6, activeAuthors: 40, laughShare: 0.5, reactionShare: 0, deltaDb: 15 } } as FeedClip))
  .toBe('чат ×4 · реакция 10 % активных · звук +15 дБ');
expect(clipSummary({ signals: { chatSpike: 5.2, laughShare: 0.61, reactionShare: 0, deltaDb: 14 } } as FeedClip))
  .toBe('чат ×5,2 · смех 61 % · звук +14 дБ');                       // старый клип — как раньше
it('shows «оценка 4,3» and no score for a manual clip', …);           // ClipCard
it('passes scores.total to the feed row and the limiter', …);         // cutter: событие total 7.5 → clip.score 7.5; лимит сравнивает total
```
- [ ] **Step 2: `npx vitest run tests/web tests/service` — FAIL**
- [ ] **Step 3: Реализовать**; обновить все места, где тесты и фикстуры строят события со `scores.S` / `triggers: ['mass']`.
- [ ] **Step 4: `npx vitest run && npm run typecheck && npm run web:build` — всё PASS**
- [ ] **Step 5: Commit** `feat: 1-10 clip score and reaction label in service and feed`
