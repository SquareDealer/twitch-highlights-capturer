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

stdin frames: 1 byte type, uint32 LE length, body. Type 0 = PCM s16le mono 16 kHz;
type 1 = JSON `{"type":"epoch","epoch":N}` or `{"type":"stop"}`. EOF on stdin also stops the process.
stdout: JSON lines `event`, `signals` (1/s), `nearmiss`, `status`, `heartbeat` (5 s). Logs go to stderr.

## Tests

```
.venv/Scripts/python -m pytest
```
