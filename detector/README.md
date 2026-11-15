# hl_detector

Headless highlight detector: reads 16 kHz mono PCM from stdin, watches Twitch chat, prints JSON lines on stdout.

## Install

```
python -m venv .venv
.venv/Scripts/pip install -e .[dev]        # Windows; on Linux/macOS: .venv/bin/pip
```

## VAD model

The Silero VAD ONNX model is not bundled (and the `silero-vad` pip package is not used: it pulls torch).
Download `silero_vad.onnx` from the snakers4/silero-vad repository
(`src/silero_vad/data/silero_vad.onnx`) into `detector/models/silero_vad.onnx` (git-ignored),
or point the `HL_VAD_MODEL` environment variable at the file.

## Run

```
python -m hl_detector --channel <login> --config <path.json> [--no-chat]
```

stdin frames: 1 byte type, uint32 LE length, body. Type 0 = PCM s16le mono 16 kHz; type 1 = JSON control:

- `{"type":"epoch","epoch":N,"startMs":M}` — a new timeline. The detector's audio clock starts at stream time
  `M` ms of epoch `N` (`startMs` absent → 0). The supervisor sends `M` = PCM bytes of the epoch received so far / 32,
  so a detector restarted mid-epoch stays on the epoch's stream time. Warmup counts from `M`.
- `{"type":"resync","tMs":T}` — PCM before stream time `T` was dropped upstream (backpressure or the detector was
  down). The clock jumps to `T`: the partial block is discarded, an open audio spike is closed at the gap,
  baselines are kept, no ticks are produced for the gap. A `T` at or behind the clock is ignored.
- `{"type":"stop"}`. EOF on stdin also stops the process.

All times on stdout (`tMs`, `startMs`, …) are in the epoch's stream time, the same timeline as the ring-buffer segments.
stdout: JSON lines `event`, `signals` (1/s), `nearmiss` (carries `epoch`), `status`, `heartbeat` (5 s).
Logs go to stderr.

## Tests

```
.venv/Scripts/python -m pytest
```
