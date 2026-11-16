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


def run_chat(before, msgs, after):
    """PCM/control bytes `before`, then chat `msgs` [(seconds after the audio clock at that point, user, text)], then `after`.

    The clock is constant, so a message `d` seconds after the wall clock lands `d` seconds after the last fed audio."""
    import threading

    W = 1_700_000_000_000
    g1, g2 = threading.Event(), threading.Event()
    chat = _ScriptedChat([("wait", g1)] + [("msg", (W + int(d * 1000), u, t)) for d, u, t in msgs] + [("set", g2)])
    stdin = _Script([("data", before), ("set", g1), ("wait", g2), ("data", after)])
    out = io.StringIO()
    rc = main(["--channel", "x", "--config", CFG], stdin=stdin, stdout=out, chat=chat, vad=FakeVad(), clock=lambda: W)
    assert rc == 0
    return [json.loads(line) for line in out.getvalue().splitlines()]


LAUGHS = [(1, "u%d" % i, "ахахах") for i in range(4)]


def test_main_emits_event_for_scripted_input():
    lines = run_chat(pcm_frames(speech(80) + tone(-24, 0.6)), LAUGHS, pcm_frames(speech(12)) + ctl({"type": "stop"}))
    events = [l for l in lines if l["type"] == "event"]
    assert len(events) == 1
    ev = events[0]
    assert ev["triggers"] == ["laugh", "audio"] and ev["confidence"] == "normal"
    assert 79_900 <= ev["startMs"] <= 80_100 and ev["triggerTimeMs"] == 82_000
    assert set(ev["scores"]) == {"total", "share", "speed", "audio"} and 1 <= ev["scores"]["total"] <= 10
    assert ev["signals"]["triggerMessages"] == 4 and ev["signals"]["activeAuthors"] == 10
    assert sum(1 for l in lines if l["type"] == "signals") >= 90
    assert any(l["type"] == "signals" and l["warm"] for l in lines)


def test_main_voice_spike_without_chat_creates_no_event():
    pcm = speech(80) + tone(-24, 0.6) + speech(12)
    lines = run(pcm_frames(pcm) + ctl({"type": "stop"}))
    assert [l for l in lines if l["type"] in ("event", "nearmiss")] == []


def test_main_signals_line_has_trigger_fields():
    lines = run_chat(pcm_frames(speech(70)), LAUGHS, pcm_frames(speech(3)) + ctl({"type": "stop"}))
    sig = [l for l in lines if l["type"] == "signals"]
    assert all({"triggerShare", "triggerMessages", "activeAuthors"} <= set(s) for s in sig)
    s = [s for s in sig if s["tMs"] == 72000][0]
    assert (s["triggerMessages"], s["activeAuthors"], s["triggerShare"]) == (4, 10, 0.4)
    assert s["messages"] == 4 and s["laughShare"] == 1.0


def test_main_epoch_frame_resets_timeline():
    before = pcm_frames(speech(5)) + ctl({"type": "epoch", "epoch": 1}) + pcm_frames(speech(70) + tone(-24, 0.6))
    lines = run_chat(before, LAUGHS, pcm_frames(speech(3)) + ctl({"type": "stop"}))
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


class _Script:
    """stdin double: serves bytes / waits for / sets threading events in order, so thread interleaving is deterministic."""

    def __init__(self, steps):
        self.steps, self.buf = list(steps), b""

    def read(self, n):
        while not self.buf:
            if not self.steps:
                return b""
            kind, v = self.steps.pop(0)
            if kind == "wait":
                assert v.wait(10)
            elif kind == "set":
                v.set()
            else:
                self.buf = v
        out, self.buf = self.buf[:n], self.buf[n:]
        return out


class _ScriptedChat:
    def __init__(self, steps):
        self.steps = steps

    async def messages(self):
        import asyncio

        for kind, v in self.steps:
            if kind == "msg":
                yield v
            elif kind == "set":
                v.set()
            else:
                while not v.is_set():
                    await asyncio.sleep(0.005)


def _frame(kind, body):
    out = io.BytesIO()
    write_frame(out, kind, body)
    return out.getvalue()


def test_chat_time_translation_drops_early_and_resets_with_epoch():
    import threading

    W = 1_700_000_000_000
    g = {i: threading.Event() for i in range(1, 8)}
    laugh = "ахахах"

    def msgs(n, wall):
        return [("msg", (wall, "u%d" % i, laugh)) for i in range(n)]

    # constant clock: offset = W - audio_ms after the latest PCM frame (minimum per epoch), applied at message receipt
    chat = _ScriptedChat(
        [("msg", (W + 2000, "early", laugh)), ("set", g[1]), ("wait", g[2])]
        + msgs(10, W + 2000)  # offset at receipt W-10000 -> t=12000
        + [("set", g[3]), ("wait", g[4]), ("msg", (W + 1000, "stale", laugh)), ("set", g[5]), ("wait", g[6])]
        + msgs(3, W + 1000)  # epoch 1: offset at receipt W-5000 -> t=6000
        + [("set", g[7])]
    )
    stdin = _Script([
        ("wait", g[1]), ("data", _frame(0, speech(10))), ("set", g[2]), ("wait", g[3]),
        ("data", _frame(0, speech(5))), ("data", ctl({"type": "epoch", "epoch": 1})), ("set", g[4]), ("wait", g[5]),
        ("data", _frame(0, speech(5))), ("set", g[6]), ("wait", g[7]),
        ("data", _frame(0, speech(2))), ("data", ctl({"type": "stop"})),
    ])
    out = io.StringIO()
    rc = main(["--channel", "x", "--config", CFG], stdin=stdin, stdout=out, chat=chat, vad=FakeVad(), clock=lambda: W)
    assert rc == 0
    lines = [json.loads(l) for l in out.getvalue().splitlines()]
    sig = [l for l in lines if l["type"] == "signals"]
    split = next(k for k in range(1, len(sig)) if sig[k]["tMs"] < sig[k - 1]["tMs"])
    e0, e1 = sig[:split], sig[split:]
    # epoch 0: 10 counted, the pre-PCM message dropped (it would have made 11)
    assert max(s["messages"] for s in e0) == 10
    assert [s for s in e0 if s["tMs"] == 15000][0]["messages"] == 10
    assert [s for s in e0 if s["tMs"] == 15000][0]["laughShare"] == 1.0
    # epoch 1: offset was reset (stale offset would put them at t=14000), the pre-PCM stale message dropped
    assert e1[0]["tMs"] == 1000
    assert [s for s in e1 if s["tMs"] == 7000][0]["messages"] == 3
    assert [s for s in e1 if s["tMs"] == 7000][0]["laughShare"] == 1.0


def _sig(lines):
    return [l for l in lines if l["type"] == "signals"]


def _events(lines):
    return [l for l in lines if l["type"] == "event"]


def test_epoch_start_ms_continues_the_stream_timeline():
    before = ctl({"type": "epoch", "epoch": 2, "startMs": 120000}) + pcm_frames(speech(70) + tone(-24, 0.6))
    lines = run_chat(before, LAUGHS, pcm_frames(speech(12)) + ctl({"type": "stop"}))
    sig = _sig(lines)
    assert sig[0]["tMs"] == 121000
    assert sig[-1]["tMs"] == 202000
    # warmup counts from the detector's start within the epoch, not from the epoch's t=0
    assert not any(s["warm"] for s in sig if s["tMs"] < 180000)
    assert [s for s in sig if s["tMs"] == 180000][0]["warm"]
    ev = _events(lines)
    assert ev and ev[0]["epoch"] == 2 and ev[0]["triggers"] == ["laugh", "audio"]
    assert 189_900 <= ev[0]["startMs"] <= 190_100
    assert ev[0]["endMs"] >= ev[0]["startMs"] and ev[0]["triggerTimeMs"] == 192_000


def test_epoch_without_start_ms_starts_at_zero():
    lines = run(ctl({"type": "epoch", "epoch": 1}) + pcm_frames(speech(3)) + ctl({"type": "epoch", "epoch": 2, "startMs": "x"})
                + pcm_frames(speech(2)) + ctl({"type": "stop"}))
    assert [s["tMs"] for s in _sig(lines)] == [1000, 2000, 3000, 1000, 2000]


def test_resync_moves_the_clock_over_the_gap():
    before = (ctl({"type": "epoch", "epoch": 3}) + pcm_frames(speech(70)) + ctl({"type": "resync", "tMs": 200000})
              + pcm_frames(speech(8) + tone(-24, 0.6)))
    lines = run_chat(before, LAUGHS, pcm_frames(speech(12)) + ctl({"type": "stop"}))
    ts = [s["tMs"] for s in _sig(lines)]
    assert ts[69] == 70000 and ts[70] == 201000  # no fake ticks over the gap
    assert ts[-1] == 220000
    ev = _events(lines)
    assert ev and ev[0]["epoch"] == 3 and ev[0]["triggers"] == ["laugh", "audio"]
    assert 207_900 <= ev[0]["startMs"] <= 208_100


def test_resync_behind_the_clock_is_ignored():
    data = (ctl({"type": "epoch", "epoch": 1, "startMs": 10000}) + pcm_frames(speech(3))
            + ctl({"type": "resync", "tMs": 12000}) + pcm_frames(speech(2)) + ctl({"type": "stop"}))
    assert [s["tMs"] for s in _sig(run(data))] == [11000, 12000, 13000, 14000, 15000]


def test_resync_mid_second_discards_the_partial_block():
    half = speech(0.55)  # 5 full blocks + half a block pending
    data = ctl({"type": "epoch", "epoch": 1}) + pcm_frames(half) + ctl({"type": "resync", "tMs": 5000}) \
        + pcm_frames(speech(2)) + ctl({"type": "stop"})
    assert [s["tMs"] for s in _sig(run(data))] == [6000, 7000]


def test_nearmiss_lines_carry_the_epoch():
    spam = [(1, "solo", "ахахах")] * 4  # one author: not enough authors
    before = ctl({"type": "epoch", "epoch": 4, "startMs": 5000}) + pcm_frames(speech(70))
    lines = run_chat(before, spam, pcm_frames(speech(3)) + ctl({"type": "stop"}))
    near = [l for l in lines if l["type"] == "nearmiss"]
    assert near and all(n["epoch"] == 4 and n["kind"] == "chat" and n["missing"] == ["authors"] for n in near)


def test_chat_time_translation_uses_the_shifted_audio_clock():
    import threading

    W = 1_700_000_000_000
    g = {i: threading.Event() for i in range(1, 4)}
    chat = _ScriptedChat([("wait", g[1])] + [("msg", (W + 2000, "u%d" % i, "ахахах")) for i in range(10)] + [("set", g[2])])
    stdin = _Script([
        ("data", ctl({"type": "epoch", "epoch": 1, "startMs": 120000})), ("data", _frame(0, speech(10))), ("set", g[1]),
        ("wait", g[2]), ("data", _frame(0, speech(5))), ("data", ctl({"type": "stop"})),
    ])
    out = io.StringIO()
    rc = main(["--channel", "x", "--config", CFG], stdin=stdin, stdout=out, chat=chat, vad=FakeVad(), clock=lambda: W)
    assert rc == 0
    sig = _sig([json.loads(l) for l in out.getvalue().splitlines()])
    # offset = W - 130000 -> messages land at t=132000, inside the 5 s window at 135000
    assert [s for s in sig if s["tMs"] == 131000][0]["messages"] == 0
    assert [s for s in sig if s["tMs"] == 135000][0]["messages"] == 10


def CONFIG(v, **chat):
    return ctl({"type": "config", "version": v, "detector": {"chat": chat}})


def test_config_frame_is_acknowledged_and_applied_without_reset():
    lines = run_chat(pcm_frames(speech(70)) + CONFIG(2, minTriggerMessages=5), LAUGHS,
                     pcm_frames(speech(12)) + ctl({"type": "stop"}))
    assert {"type": "config", "version": 2, "badPatterns": []} in lines
    assert _events(lines) == []  # 4 messages < 5
    assert all(l["warm"] for l in _sig(lines) if l["tMs"] >= 71000)  # warmup not reset


def test_config_frame_before_epoch_is_used_by_the_new_chat_analyzer():
    before = pcm_frames(speech(3)) + CONFIG(5, minActive=20) + ctl({"type": "epoch", "epoch": 1}) + pcm_frames(speech(70))
    lines = run_chat(before, LAUGHS, pcm_frames(speech(3)) + ctl({"type": "stop"}))
    assert {"type": "config", "version": 5, "badPatterns": []} in lines
    sig = _sig(lines)
    split = next(k for k in range(1, len(sig)) if sig[k]["tMs"] < sig[k - 1]["tMs"])
    assert all(s["activeAuthors"] == 20 for s in sig[split:])  # the default minActive is 10
    s = [s for s in sig[split:] if s["tMs"] == 72000][0]
    assert (s["triggerMessages"], s["triggerShare"]) == (4, 0.2)


def test_bad_patterns_are_returned():
    lines = run(CONFIG(3, laughWords=["^([ах]+)+$", "^lol$"]) + ctl({"type": "stop"}))
    assert {"type": "config", "version": 3, "badPatterns": ["^([ах]+)+$"]} in lines


def test_invalid_config_frame_is_refused_and_old_values_stay():
    lines = run_chat(pcm_frames(speech(70)) + ctl({"type": "config", "version": 4,
                                                   "detector": {"chat": {"minTriggerMessages": "x"}}}),
                     LAUGHS, pcm_frames(speech(12)) + ctl({"type": "stop"}))
    ack = [l for l in lines if l["type"] == "config"][0]
    assert ack["version"] == 4 and ack["error"] and ack["badPatterns"] == []
    assert len(_events(lines)) == 1


def test_config_frame_with_non_integer_version_is_refused():
    lines = run(ctl({"type": "config", "version": "2", "detector": {}}) + ctl({"type": "stop"}))
    ack = [l for l in lines if l["type"] == "config"][0]
    assert ack["error"] and ack["badPatterns"] == []


def test_signals_line_carries_detail():
    lines = run_chat(pcm_frames(speech(70)) + CONFIG(7), LAUGHS, pcm_frames(speech(3)) + ctl({"type": "stop"}))
    d = [l for l in lines if l["type"] == "signals" and l["tMs"] == 72000][0]["detail"]
    assert d["configVersion"] == 7 and d["sinceStartMs"] == 72000
    assert (d["chat"]["triggerMessages"], d["chat"]["triggerAuthors"], d["chat"]["activeAuthors"], d["chat"]["activeAuthorsRaw"]) == (4, 4, 10, 4)
    assert d["conditions"] == {"warm": True, "messages": True, "authors": True, "share": True, "fired": True}
    assert d["event"]["chatOpen"] is True and d["score"]["total"] >= 1
    assert set(d["audio"]) == {"db", "baselineDb", "deltaDb", "vad", "warm", "spiking"}


def test_detail_is_present_before_any_audio_or_config():
    lines = run(pcm_frames(speech(1)) + ctl({"type": "stop"}))
    d = _sig(lines)[0]["detail"]
    assert d["configVersion"] == 0 and d["event"] is None and d["sinceStartMs"] == _sig(lines)[0]["tMs"]
    assert d["audio"]["warm"] is False and d["audio"]["spiking"] is False


def test_absurd_config_value_is_refused_and_detector_keeps_running():
    lines = run_chat(pcm_frames(speech(70)) + CONFIG(5, windowS=1e306), LAUGHS,
                     pcm_frames(speech(12)) + ctl({"type": "stop"}))
    ack = [l for l in lines if l["type"] == "config" and l["version"] == 5][0]
    assert ack["error"] and ack["badPatterns"] == []
    assert len(_events(lines)) == 1
    assert any(l["tMs"] > 71000 for l in _sig(lines))
