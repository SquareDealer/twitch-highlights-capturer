# Service smoke checklist

## Detector process (Task 7)

### Step 5: live chat check

`sleep 20 | python -m hl_detector --channel gaules --config ../config.example.json` (stdin held open;
with `< NUL` the process sees EOF and exits at once, by design). Output over 20 s: `status chat=connected`
followed by `heartbeat` every 5 s. Result: OK (live channel: gaules).

### Step 6: early load measurement (spec section 12, item 1)

Method: throwaway script `spike-load.mjs` (not committed) runs, per copy,
`streamlink --stdout twitch.tv/<ch> best | ffmpeg -map 0:a:0 -ac 1 -ar 16000 -f s16le pipe:1` and wraps the output
into type-0 frames for `python -m hl_detector` (real Silero VAD, real Twitch IRC). Channels live at the time:
gaules, lirik, eslcs. Window: 30 s warm-up, then 120 s measured (shortened from the planned 5 minutes).
Machine: 8 logical cores, Windows 10. CPU is process-tree CPU time over the window; "core" = % of one core,
"machine" = % of the whole 8-core machine. Memory is working set at the end of the window.

| Copies | detector CPU (core / machine) | ffmpeg CPU | streamlink CPU | Total CPU (core / machine) | Memory (detector + ffmpeg + streamlink) |
|---|---|---|---|---|---|
| 1 | 0.7 % / 0.1 % | 0.2 % | 0.6 % | 1.5 % / 0.2 % | 70 + 22 + 60 MB |
| 3 | 2.1 % / 0.3 % | 0.8 % | 2.1 % | 5.0 % / 0.6 % | 210 + 65 + 177 MB |
| 5 | 3.7 % / 0.5 % | 1.4 % | 3.7 % | 8.8 % / 1.1 % | 350 + 108 + 299 MB |

Conclusion: 5 copies use about 1 % of the machine, far below the 60 % threshold; the process-per-stream
design is not in question. The detector emitted `signals` once per second per copy and `status connected`
for every copy; no events fired (no loud voice spikes during the windows).

## Service entrypoint, live run (Task 14)

Date: 2026-11-15, Windows 10, 8 logical cores. `npm run service` (tsx), `config.json` created on first run
(password printed once), `pythonPath` pointed at `detector/.venv/Scripts/python.exe`. All steps driven with `curl`
against the HTTP API (login → probe → start → manual clip → list → download). Main channel: `recrent`
(Russian-speaking, `best` = 1080p60 source). The web UI was not opened in a browser (only `GET /` → 200 checked).

### 1. Start, manual clip, download

- Login 204; probe listed `best, 1080p60, 720p60, …`; stream `RECORDING` within ~5 s, detector `chat=connected`.
- «Сохранить последние 60 с» at ~74 s of recording (not the full 2 minutes): response 201 in 1.4 s, status `new`,
  `durationMs` 60000, 57.8 MB. Four more manual clips were taken later in the run, all `new`.
- Download `?download=1`: 200, `video/mp4`, `Content-Disposition: attachment; filename="2026-11-15_21-46-41_manual_c0f1.mp4"`;
  a `Range: bytes=0-99` request returns 206 (seekable in a `<video>` element).
- `ffprobe`: `h264 1920x1080 60 fps` + `aac 48 kHz`, duration 60.03 s — source resolution and codecs, no re-encode.

### 2. Synchronization (spec §11)

Method (`scripts/sync-check.md`, objective variant): a poller recorded every detector `signals` sample
(`tMs`, `deltaDb` = 100-ms block level above baseline) from `/api/state`; for a manual clip the MP4 audio was decoded
to 16 kHz mono and 100-ms block levels were correlated with the detector samples over offsets −3…+3 s (10 ms step).
The best offset is where the detector's PCM timeline and the clip's MP4 timeline agree, i.e. the error of
`estimatedEventMs − startMs`. A loud-sound `audio` trigger did not fire during the run (see 5), so manual clips were used.

| When | Epoch | Clip range (ms) | Best offset | Correlation r |
|---|---|---|---|---|
| ~3 min after start | 0 | 142000–202000 | **0 ms** (±10) | 0.997 |
| after reconnect (see 4), ~3 min into the new epoch, 3 streams running | 1 | 120000–180000 | **0 ms** (±10) | 0.80 |
| ~15 min into epoch 1 (~22 min of recording), 5 streams running | 1 | 834000–894000 | **0 ms** (±10) | 0.996 |
| **after the detector process was killed and restarted** | 0 | 286000–346000 | **+219 590 ms** | 0.999 |

Result: within an epoch the detector timeline matches the video exactly and does not drift (0 ms at 3 and 15 min).
**Failure found (fixed in e6cd832, re-checked live below — «2a. Re-check after the detector clock fix»):** when the detector process restarts in the middle of an epoch, the new process counts PCM from 0
while the segment timeline continues, so all its event times are off by the time the epoch had run before the restart
(219.6 s here) plus any PCM dropped while it was down. Events from a restarted detector would cut the wrong footage
(or nothing, if that time is already outside the 300-s buffer) until the next reconnect starts a new epoch.
Per §11 this is a > 1.5 s discrepancy: **a follow-up task is needed** (e.g. `DetectorProcess` counts PCM bytes per epoch
and sends the base offset with the `epoch` frame, or shifts event/signals/nearmiss times by the offset at launch;
PCM dropped on back-pressure shifts the timeline the same way). The pilot should not be considered ready until it is fixed.
The 30-minute repeat was shortened to 15 minutes; the repeat after a real 20-s network cut — not run, needs a human
(the reconnect case was covered by killing streamlink, below).

### 2a. Re-check after the detector clock fix (e6cd832 + final fix wave)

Date: 2026-11-15, same machine, `npm run service` with `diskReserveBytes` lowered to 2 GB (the system disk had 9.8 GB
free, so the default 10 GB reserve paused cutting), one stream `recrent` `best` (1080p60). Same objective method
(`scripts/sync-check.md`): a poller stored every `signals` sample from `/api/state` every 200 ms; manual clips were
downloaded and their audio correlated with the detector samples over −3…+3 s (10 ms step). The clip's `startMs` is now
the start of its first segment (the footage actually cut), so the MP4 timeline starts exactly at `startMs`.

| When | Epoch | Clip range (ms) | Best offset | r (r at 0) |
|---|---|---|---|---|
| detector python killed (`Stop-Process`) at tMs ≈ 150 s; clip ~95 s after the restart | 0 | 188000–248000 | **−80 ms** | 0.9985 (0.903) |
| detector suspended for 6 s at tMs ≈ 290 s (stdin back-pressure → PCM dropped → `resync` frame); clip ~80 s after | 0 | 316000–376000 | **−80 ms** | 0.9955 (0.927) |
| reference: new session, fresh detector process, no restart; clip at ~2.5 min | 0 | 90000–150000 | **−10 ms** | 0.9965 (0.992) |

- After the kill the detector restarted within ~1 s (`restarts: 1`) and its `tMs` continued on stream time (151 s
  right after the restart, no jump back to 0). The service logged `Детектор завершился (код 4294967295)` once
  (the new exit log; no stderr tail because the process was killed).
- During the 6-s suspension `tMs` stopped at 290 s, then jumped 293 → 297 s within 0.6 s of wall time (the resync
  frame) and continued at 1 s/s; no heartbeat restart.
- Result: after a restart and after a forced resync the detector timeline agrees with the video within **80 ms**
  (tolerance 1.5 s), versus 219.6 s before the fix. The remaining −80 ms vs −10 ms for a fresh process is, as far as
  we can tell, a property of the measurement, not of event times: a `signals` sample reports the last *complete*
  100-ms block, and after a restart/resync the detector's block grid starts at the re-announced stream time
  (`AudioAnalyzer.reset/skip_to`), not on a multiple of 100 ms, so the sampled block ends up to 100 ms before `tMs`.
  Event times are taken from block start times on the same (correct) timeline. Not proven beyond this run.
- Shutdown with Ctrl-C: «Получен SIGINT, сервис останавливается…», no streamlink/ffmpeg/python processes left, the
  buffer directory empty. Stopping a stream via `DELETE /api/streams/:id` took 0.38 s.
- No detector clip fired during this ~12-min run, so «last event flushed on stop» was verified by unit tests only.

### 3. Load

Process tree of the service (node + streamlink + ffmpeg + detector python per stream), CPU time over 60 s:

| Streams | Total CPU (one core / machine) | Memory |
|---|---|---|
| 1 (recrent) | 3.9 % / 0.5 % | 273 MB |
| 3 (+ gaules, lirik) | 11.2 % / 1.4 % | 651 MB |
| 5 (+ eslcs, zackrawrr) | 18.1 % / 2.3 % | 1024 MB |

Per stream ≈ 3.5 % of a core and ~190 MB (streamlink ~66 MB, detector ~54 MB, ffmpeg ~25 MB, conhost ×3 ~35 MB);
node itself 3.1 % / 75 MB at 5 streams. A 6th stream was refused with the limit message (409).
GTX 1050 Ti machine: not available. Latency "end of moment → clip in feed": no detector clip fired, so it was not
measured for auto clips; manual clips appear in 1.4 s (the clip only needs already-recorded segments).

### 4. Failures

- **Detector killed** (`Stop-Process` on the detector python): restarted within ~1 s (`restarts: 1`), chat reconnected,
  recording not interrupted (`bufferedMs` kept growing). The timeline offset failure of item 2 is fixed: see 2a.
- **Capture killed** (streamlink and its python killed, as a stand-in for a network cut): the session reconnected by
  itself, a new epoch 1 started, the detector got the new PCM (`tMs` restarted from 0 together with the segments) and
  kept producing signals; sync in the new epoch is 0 ms (item 2).
- Pulling the network cable for 20 s: not run — needs a human.
- **Shutdown** (Ctrl-C in a terminal, one stream recording): «Получен SIGINT, сервис останавливается…», process exited,
  no streamlink/ffmpeg/python left behind, buffer directory empty. Stopping streams through `DELETE /api/streams/:id`
  takes ~0.45 s each.

### 5. Baseline numbers (shortened run)

`recrent` was recorded ~22 min (one reconnect), gaules/lirik ~11 min, eslcs/zackrawrr ~9 min, 5 streams at once for
the last ~9 min. Chat on recrent was slow (0–4 messages/s).

- Detector clips: **0** on all five channels (so nothing to mark taken/rejected). 5 manual clips, all `new`.
- Near-misses (`data/nearmiss/`): recrent 20 (all `audio`, missing `strong` — voiced spikes that never held
  `triggerDb` 15 dB with VAD ≥ 0.7 for `triggerMinMs` 500 ms; peaks −18…−24 dBFS), gaules 16 (all `audio:strong`), lirik 10 (6 `chat` missing
  `laugh_share+mass_spike`, 3 of them also before warm-up; 4 `audio:strong`), zackrawrr 4 (3 `chat`, 1 `audio:strong`),
  eslcs 0.
- Takeaway for threshold tuning: every audio near-miss failed the `strong` run (15 dB / VAD 0.7 / 500 ms), chat ones failed laugh share and mass spike;
  a longer run on an active channel is still needed before changing thresholds.

## Profiles and tuning mode

Live check, 2026-11-16, head 7777c43. A separate instance was used so the working data stayed untouched:
`HL_CONFIG`/`HL_DATA` pointed at a scratch folder (copy of `config.json`, port 8099, `diskReserveBytes` 0).
Steps 1–2 and 4–6 were driven through the HTTP API with a script, step 3 and the look of the pages in the browser.
Channels: gaules (quiet chat at the time), then fps_shaka (active chat), quality 160p30.

- [x] 1. The «Профили» tab has «По умолчанию» with the values from `config.json` (`minTriggerShare` 0.05, `preRollMs` 15000). The start-up log prints the one-time notice about the profile.
- [x] 2. Copy «Тест» created and selected on the running stream: status went `profileVersion` 2 / `profileApplied` 1, the detector confirmed version 2 after 1.3 s (`detail.configVersion` 2), the log shows `применён профиль «Тест»`.
- [x] 3. «Настройка» on: the four condition rows, the chat/sound/score lines refresh every second, both charts draw with their threshold lines, the log lists the entries.
- [x] 4. «Доля активных, не меньше» changed to 0.5 and saved: the detector confirmed version 3 after 0.8 s; detector restarts 0, `running` true, `sinceStartMs` went on 77 s → 79 s, chat and audio warm-up stayed `true`.
- [x] 5. Pattern `^([ах]+)+$` in «Смех»: 400 «шаблон может подвесить детектор (повторение после скобок или обратная ссылка)», path `detector.chat.laughWords`.
- [x] 6. Stream stopped, «Тест» deleted (204), probe of the channel returns the id of «По умолчанию».

End to end on fps_shaka (profile loosened on the running stream: 1 message, 1 author, share 0.001, extra laugh patterns):
the config was applied at second ~20 without a reset (the chat baseline kept growing 2 → 4.5), the trigger fired at
second 42 on one laugh message, the event stayed open while the chat speed was above `endSpike` (peak ×7.7), a clip
of 38 s was cut with score 4.6 (share 0.6 + speed 3), `profileName` «Тест», and the log got the `clip` entry.

Seen and fixed afterwards: the sound line printed «+-48,1 дБ» for a negative difference, and «4 сообщений».

## Spike-then-composition trigger, interactive tuning, Google Drive

Live check, 2026-11-17, branch `feat/realtime-service` after the «Drive tab and Sync button» commit. A separate
instance on port 8099 with `HL_CONFIG`/`HL_DATA` in a scratch folder; the database was a **copy of the working
`service.sqlite`** (its clip paths re-pointed away from the real library so the janitor could not touch real files).
Channels at 160p30: gaules (chat silent the whole time), zackrawrr and jynxzi (active chat). Pages were driven in the browser,
state was read through the HTTP API.

- [x] 1. Migration on the real database: «По умолчанию» came up with `minSpike` 2, `minTriggerShare` 0.5 (was 0.02),
  `shareFull` 0.9 (was 0.2); `minActive`/`activeWindowS` gone; the hand-tuned `alpha` 0.5 and the rest untouched.
- [x] 2. «Настройка»: the chain «Всплеск → Состав → Звук» refreshes every second (zackrawrr: ×1,2, 31,8 % — 7 из 22),
  the composition step is dimmed while there is no spike, both charts draw with their thresholds.
- [x] 3. Draft thresholds typed into the chart inputs (×1,5 and 30 %): the saved thresholds stay as dashed lines, the
  counter shows «(с сохранёнными — 0)», «изменения ещё не применены» and the other streams on the profile are named;
  nothing reached the detectors (`profileVersion` stayed 1).
- [x] 4. «Применить к профилю»: all three detectors confirmed version 2 within ~2 s, restarts 0, frames kept counting,
  the chain's «нужно» values changed.
- [x] 5. «Профили»: six basic fields with sliders, the dot and «вернуть 10 с» on a changed field, collapsed groups,
  dictionaries as chips, «Проверить сообщение»: «АХАХАХА» → «смех».
- [x] 6. «Диск» without keys: redirect address `http://localhost:8099/api/drive/callback`, steps 2–3 closed;
  the feed shows «Sync: настроить Диск»; old clips keep the «реакция 2 % активных» caption.
- [ ] 7. **Not seen live:** no second fired on the two active chats in ~3 minutes (peaks were ×2,4 with 11 % composition),
  so no clip was cut by the new rule in this run. The rule itself is covered by the detector tests.
- [ ] 8. **For the customer, needs a Google account:** save the keys of a «Web application» OAuth client, sign in,
  choose the existing `to_sort` (by name and by link), «Sync» two taken clips, press «Sync» again — no duplicates,
  the cards show «на Диске».

Seen and fixed afterwards: near-misses were written for any speed spike, even with no trigger messages and during
warm-up (8 entries in 2 minutes) — now only when exactly one condition is missing; the warm-up burst (×39 while the
baseline is empty) flattened the speed chart so the threshold line sat on the bottom edge — the scale is now capped.
