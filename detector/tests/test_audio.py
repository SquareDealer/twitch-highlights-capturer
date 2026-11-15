import math

import numpy as np

from hl_detector.audio import AudioAnalyzer
from hl_detector.config import DEFAULTS

SR = 16000


class FakeVad:
    def __init__(self, p=0.9):
        self.p = p
        self.resets = 0

    def prob(self, samples):
        return self.p

    def reset(self):
        self.resets += 1


def tone(db_rms: float, seconds: float) -> bytes:
    """Sine whose RMS is db_rms dBFS, as s16le mono 16 kHz."""
    amp = 10 ** (db_rms / 20) * math.sqrt(2)
    n = int(SR * seconds)
    x = amp * np.sin(2 * np.pi * 220 * np.arange(n) / SR)
    return (x * 32767).astype("<i2").tobytes()


def mk(vad=None):
    v = vad or FakeVad()
    return AudioAnalyzer(DEFAULTS["audio"], v), v


def test_block_timing():
    a, _ = mk()
    pcm = tone(-30, 1.0)
    for i in range(0, len(pcm), 333):
        a.feed(pcm[i:i + 333])
    fr = a.frames()
    assert [f.t_ms for f in fr] == [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]
    assert abs(fr[0].db + 30) < 0.5
    assert a.frames() == []


def test_voice_spike_plus_10db():
    a, _ = mk()
    a.feed(tone(-30, 30))
    a.feed(tone(-18, 0.5))
    a.feed(tone(-30, 1.0))
    sp = a.spikes()
    assert len(sp) == 1
    assert sp[0].strong is False
    assert sp[0].start_ms == 30000 and sp[0].end_ms == 30500
    assert abs(sp[0].peak_db + 18) < 0.5
    assert abs(sp[0].delta_db - 12) < 1.0
    assert a.spikes() == []


def test_strong_spike_plus_15db_500ms():
    a, _ = mk()
    a.feed(tone(-30, 30))
    a.feed(tone(-12, 0.6))
    a.feed(tone(-30, 1.0))
    sp = a.spikes()
    assert len(sp) == 1 and sp[0].strong is True


def test_loud_without_speech_is_ignored():
    v = FakeVad(0.9)
    a, _ = mk(v)
    a.feed(tone(-30, 30))
    v.p = 0.1
    a.feed(tone(-12, 0.6))
    v.p = 0.9
    a.feed(tone(-30, 1.0))
    assert a.spikes() == []


def test_short_blip_is_ignored():
    a, _ = mk()
    a.feed(tone(-30, 30))
    a.feed(tone(-10, 0.2))
    a.feed(tone(-30, 1.0))
    assert a.spikes() == []


def test_no_spikes_until_warm():
    a, _ = mk()
    a.feed(tone(-30, 2))
    a.feed(tone(-12, 0.6))
    a.feed(tone(-30, 1.0))
    assert a.spikes() == []
    assert all(not f.warm for f in a.frames())


def test_recent_spikes():
    a, _ = mk()
    a.feed(tone(-30, 30))
    a.feed(tone(-18, 0.5))
    a.feed(tone(-30, 1.0))
    a.spikes()
    assert len(a.recent_spikes(29000, 31000)) == 1
    assert a.recent_spikes(0, 20000) == []


def test_reset_restarts_timeline():
    a, v = mk()
    a.feed(tone(-30, 30))
    a.frames()
    a.reset()
    assert v.resets == 1
    a.feed(tone(-30, 0.3))
    fr = a.frames()
    assert [f.t_ms for f in fr] == [0, 100, 200]
    assert not fr[0].warm
    assert a.recent_spikes(0, 10**9) == []


def test_vad_failure_is_logged_once(caplog):
    class BadVad(FakeVad):
        def prob(self, samples):
            raise RuntimeError("boom")

    a, _ = mk(BadVad())
    with caplog.at_level("ERROR", logger="hl_detector.audio"):
        a.feed(tone(-30, 1.0))
    fr = a.frames()
    assert len(fr) == 10 and all(f.vad == 0.0 for f in fr)
    recs = [r for r in caplog.records if r.name == "hl_detector.audio"]
    assert len(recs) == 1 and recs[0].exc_info
