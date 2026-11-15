import io
import json
import math

import numpy as np

from hl_detector.__main__ import main
from hl_detector.protocol import write_frame

SR = 16000
CFG = "../config.example.json"


class FakeVad:
    def prob(self, samples):
        return 0.9

    def reset(self):
        pass


class FakeChat:
    def __init__(self, items=(), error=None):
        self.items, self.error = list(items), error

    async def messages(self):
        for it in self.items:
            yield it
        if self.error:
            raise self.error


def tone(db, seconds):
    amp = 10 ** (db / 20) * math.sqrt(2)
    n = int(SR * seconds)
    x = amp * np.sin(2 * np.pi * 220 * np.arange(n) / SR)
    return (x * 32767).astype("<i2").tobytes()


def speech(sec_quiet=90):
    return tone(-40, sec_quiet)


def pcm_frames(buf, chunk=SR * 2 // 2):
    out = io.BytesIO()
    for i in range(0, len(buf), chunk):
        write_frame(out, 0, buf[i:i + chunk])
    return out.getvalue()


def ctl(obj):
    out = io.BytesIO()
    write_frame(out, 1, json.dumps(obj).encode())
    return out.getvalue()


def run(data, chat=None):
    out = io.StringIO()
    rc = main(["--channel", "x", "--config", CFG], stdin=io.BytesIO(data), stdout=out, chat=chat, vad=FakeVad(),
              clock=lambda: 1_700_000_000_000)
    assert rc == 0
    text = out.getvalue()
    assert text.endswith("\n")
    return [json.loads(line) for line in text.splitlines()]


def test_main_emits_event_for_scripted_input():
    pcm = speech(80) + tone(-24, 0.6) + speech(12)
    lines = run(pcm_frames(pcm) + ctl({"type": "stop"}))
    events = [l for l in lines if l["type"] == "event"]
    assert events and events[0]["triggers"] == ["audio"]
    assert sum(1 for l in lines if l["type"] == "signals") >= 90
    assert any(l["type"] == "signals" and l["warm"] for l in lines)


def test_main_epoch_frame_resets_timeline():
    pcm = speech(70) + tone(-24, 0.6) + speech(3)
    data = pcm_frames(speech(5)) + ctl({"type": "epoch", "epoch": 1}) + pcm_frames(pcm) + ctl({"type": "stop"})
    lines = run(data)
    sig = [l for l in lines if l["type"] == "signals"]
    i = next(k for k in range(1, len(sig)) if sig[k]["tMs"] < sig[k - 1]["tMs"])
    assert sig[i]["tMs"] == 1000
    events = [l for l in lines if l["type"] == "event"]
    assert events and all(e["epoch"] == 1 for e in events)


def test_chat_disconnect_is_reported_and_audio_still_works():
    chat = FakeChat(error=ConnectionError("boom"))
    lines = run(pcm_frames(speech(5)) + ctl({"type": "stop"}), chat=chat)
    assert {"type": "status", "chat": "disconnected"} in lines
    assert sum(1 for l in lines if l["type"] == "signals") == 5
