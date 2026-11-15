from hl_detector.audio import VoiceSpike
from hl_detector.chat import ChatFrame
from hl_detector.config import DEFAULTS
from hl_detector.events import EventAssembler


def fr(t, spike=1.0, msgs=10, authors=8, laugh=0.0, react=0.0, rep=None, warm=True, rar=0.9, arar=0.9):
    return ChatFrame(t_ms=t * 1000, messages=msgs, authors=authors, spike=spike, author_spike=1.0,
                     rarity=rar, author_rarity=arar, laugh_share=laugh, reaction_share=react,
                     repeat_class=rep, warm=warm)


def laugh_frame(t, **kw):
    kw.setdefault("spike", 5.0)
    kw.setdefault("laugh", 0.5)
    return fr(t, **kw)


def run(frames, spikes=(), until=140, asm=None):
    """frames: {sec: ChatFrame}; spikes delivered on the first tick >= end_ms."""
    asm = asm or EventAssembler(DEFAULTS)
    delivered, out, near = [], [], []
    for sec in range(0, until + 1):
        now = sec * 1000
        new = [s for s in spikes if s not in delivered and s.end_ms <= now]
        delivered += new
        rec = lambda lo, hi: [s for s in delivered if s.end_ms >= lo and s.start_ms <= hi]
        evs, nm = asm.on_tick(now, frames.get(sec, fr(sec)), new, rec)
        out += [(sec, e) for e in evs]
        near += nm
    return out, near, asm


def laugh_run(a, b, **kw):
    return {t: laugh_frame(t, **kw) for t in range(a, b)}


def test_laugh_trigger_creates_event_with_audio_anchor():
    sp = VoiceSpike(100_000, 101_000, 12.0, False, 12.0)
    out, _, _ = run(laugh_run(106, 114), [sp])
    assert len(out) == 1
    sec, e = out[0]
    assert sec == 124
    assert e.triggers == ["laugh"]
    assert (e.estimated_event_ms, e.start_ms, e.end_ms) == (100_000, 100_000, 114_000)
    assert e.uncertainty_ms == 2000 and e.confidence == "normal"
    assert e.trigger_time_ms == 106_000


def test_laugh_without_audio_uses_chat_lag_and_low_confidence():
    out, _, _ = run(laugh_run(106, 114))
    e = out[0][1]
    assert e.estimated_event_ms == 98_000 and e.uncertainty_ms == 20_000 and e.confidence == "low"


def test_fast_chat_without_laughter_no_event_but_nearmiss():
    out, near, _ = run({t: fr(t, spike=4.0) for t in range(100, 105)})
    assert out == []
    assert near and near[0].kind == "chat" and "laugh_share" in near[0].missing


def test_mass_reaction_without_laughter():
    frames = {t: fr(t, spike=7, msgs=16, authors=11, react=0.5) for t in range(106, 112)}
    out, _, _ = run(frames)
    assert [e.triggers for _, e in out] == [["mass"]]


def test_mass_with_unknown_repeat_needs_voice():
    frames = {t: fr(t, spike=7, msgs=16, authors=11, react=0.5, rep="unknown") for t in range(106, 112)}
    out, near, _ = run(frames)
    assert out == [] and any("voice" in n.missing for n in near)
    out, _, _ = run(frames, [VoiceSpike(100_000, 101_000, 12.0, False, 12.0)])
    assert len(out) == 1 and out[0][1].triggers == ["mass"]


def test_interactive_repeat_suppresses_both_triggers():
    frames = {t: fr(t, spike=7, msgs=16, authors=11, react=0.5, laugh=0.5, rep="interactive") for t in range(106, 112)}
    out, near, _ = run(frames, [VoiceSpike(100_000, 101_000, 12.0, False, 12.0)])
    assert out == []
    assert any(n.kind == "chat" and "interactive" in n.missing for n in near)


def test_strong_voice_spike_alone_is_low_confidence_audio_event():
    out, _, _ = run({}, [VoiceSpike(100_000, 101_000, -10.0, True, 20.0)])
    e = out[0][1]
    assert e.triggers == ["audio"] and e.confidence == "low"
    assert (e.estimated_event_ms, e.start_ms, e.end_ms, e.uncertainty_ms) == (100_000, 100_000, 101_000, 1000)
    assert e.scores["A"] == 1.0 and e.scores["S"] == 0.14


def test_weak_voice_spike_is_audio_nearmiss():
    out, near, _ = run({}, [VoiceSpike(100_000, 101_000, 12.0, False, 12.0)])
    assert out == [] and [n.kind for n in near] == ["audio"]


def test_events_within_10s_merge_and_collect_triggers():
    out, _, _ = run(laugh_run(106, 114), [VoiceSpike(116_000, 117_000, 12.0, True, 12.0)])
    assert len(out) == 1
    e = out[0][1]
    assert e.triggers == ["laugh", "audio"] and e.end_ms == 117_000 and e.confidence == "low"


def test_nothing_fires_during_warmup():
    out, _, _ = run(laugh_run(10, 20), [VoiceSpike(30_000, 31_000, 20.0, True, 20.0)], until=100)
    assert out == []


def test_event_longer_than_max_is_closed():
    out, _, _ = run(laugh_run(70, 200), until=210)
    assert out
    assert all(e.end_ms - e.start_ms <= 60_000 for _, e in out)


def test_score_formula():
    frames = {t: laugh_frame(t, laugh=0.6, rar=0.8, arar=0.5) for t in range(106, 110)}
    out, _, _ = run(frames, [VoiceSpike(100_000, 101_000, 10.0, False, 10.0)])
    sc = out[0][1].scores
    assert sc == {"S": 0.63, "C": 0.8, "E": 0.6, "U": 0.5, "A": 0.5}


def test_flush_returns_open_event_and_callback():
    marks = []
    asm = EventAssembler(DEFAULTS, on_chat_spike=marks.append)
    out, _, asm = run(laugh_run(106, 110), until=108, asm=asm)
    assert out == [] and marks
    evs = asm.flush()
    assert len(evs) == 1 and evs[0].to_json()["type"] == "event"
    assert asm.flush() == []


def test_realistic_audio_event_has_positive_a():
    # absolute peak is negative dBFS; A must come from delta_db above baseline
    sp = VoiceSpike(100_000, 101_000, -18.0, False, 12.0)
    out, _, _ = run(laugh_run(106, 110), [sp])
    e = out[0][1]
    assert e.scores["A"] == 0.6 and e.signals["deltaDb"] == 12.0
