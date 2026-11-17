from hl_detector.audio import VoiceSpike
from hl_detector.chat import ChatFrame
from hl_detector.config import DEFAULTS, overlay
from hl_detector.events import EventAssembler


def tf(t, msgs=4, authors=3, total=None, laugh=None, react=0, spike=2.5, warm=True):
    """A chat frame at second t: msgs trigger messages from `authors` authors among `total` messages in the window."""
    laugh = msgs - react if laugh is None else laugh
    total = msgs if total is None else total
    return ChatFrame(t_ms=t * 1000, messages=total, authors=authors, spike=spike, author_spike=1.0,
                     rarity=0.0, author_rarity=0.0, laugh_share=laugh / total if total else 0.0,
                     reaction_share=react / total if total else 0.0, repeat_class=None, warm=warm,
                     trigger_messages=msgs, trigger_authors=authors, laugh_messages=laugh, reaction_messages=react,
                     trigger_share=msgs / total if total else 0.0)


def quiet(t):
    return tf(t, msgs=0, authors=0, spike=1.0)


def run(frames, spikes=(), until=140, asm=None):
    """frames: {sec: ChatFrame}; spikes delivered on the first tick >= end_ms."""
    return run_from(0, frames, spikes, until, asm)


def run_from(start, frames, spikes=(), until=140, asm=None):
    """Same as run, ticking from second `start`."""
    asm = asm or EventAssembler(DEFAULTS)
    delivered, out, near = [], [], []
    for sec in range(start, until + 1):
        now = sec * 1000
        new = [s for s in spikes if s not in delivered and s.end_ms <= now]
        delivered += new
        rec = lambda lo, hi: [s for s in delivered if s.end_ms >= lo and s.start_ms <= hi]
        evs, nm = asm.on_tick(now, frames.get(sec, quiet(sec)), new, rec)
        out += [(sec, e) for e in evs]
        near += nm
    return out, near, asm


def span(a, b, **kw):
    return {t: tf(t, **kw) for t in range(a, b)}


def test_trigger_fires_on_spike_and_composition():
    out, _, _ = run(span(106, 110))  # chat x2.5, every message is a trigger one
    assert len(out) == 1
    sec, e = out[0]
    assert e.triggers == ["laugh"]
    assert e.scores == {"total": 4.6, "share": 3.0, "speed": 0.6, "audio": 0.0}
    assert e.trigger_time_ms == 106_000 and e.end_ms == 110_000
    # no voice spike before the chat: chat-lag anchor, low confidence
    assert e.estimated_event_ms == 98_000 and e.uncertainty_ms == 20_000 and e.confidence == "low"
    assert sec == 120
    j = e.to_json()
    assert j["signals"] == {"chatSpike": 2.5, "triggerShare": 1.0, "triggerMessages": 4, "messages": 4,
                            "laughShare": 1.0, "reactionShare": 0.0, "deltaDb": 0.0}


def test_below_three_messages_no_event():
    out, near, _ = run(span(106, 110, msgs=2, authors=2))
    assert out == [] and near[0].missing == ["messages"]


def test_one_spammer_no_event():
    out, near, _ = run(span(106, 110, msgs=5, authors=1))
    assert out == []
    assert near and near[0].kind == "chat" and near[0].missing == ["authors"]


def test_low_share_no_event_but_nearmiss():
    out, near, _ = run(span(106, 110, msgs=4, authors=4, total=20))
    assert out == []
    assert near and near[0].kind == "chat" and near[0].missing == ["share"]
    assert near[0].values["triggerShare"] == 0.2 and near[0].values["triggerMessages"] == 4


def test_nearmiss_is_rate_limited():
    _, near, _ = run(span(106, 125, msgs=4, authors=4, total=20))
    assert [n.t_ms for n in near] == [106_000, 116_000]


def test_reaction_dominant_label():
    out, _, _ = run(span(106, 110, msgs=5, authors=4, react=4))  # 'НЕЕЕТ'x4, 'ахах'x1
    assert out[0][1].triggers == ["reaction"]


def test_equal_laugh_and_reaction_is_laugh():
    out, _, _ = run(span(106, 110, msgs=4, authors=4, react=2))
    assert out[0][1].triggers == ["laugh"]


def test_voice_spike_alone_never_fires():
    out, near, _ = run({}, [VoiceSpike(100_000, 101_000, -10.0, True, 20.0)])
    assert out == [] and near == []


def test_audio_adds_points_and_label():
    sp = VoiceSpike(101_000, 102_000, -20.0, True, 15.0)  # 5 s before the chat reaction
    out, _, _ = run(span(106, 110), [sp])
    e = out[0][1]
    assert e.scores["audio"] == 0.5
    assert e.triggers == ["laugh", "audio"]
    assert e.estimated_event_ms == 101_000 == e.start_ms and e.uncertainty_ms == 2000
    assert e.confidence == "normal"
    assert e.signals["deltaDb"] == 15.0


def test_weak_voice_spike_gives_no_audio_points():
    out, _, _ = run(span(106, 110), [VoiceSpike(101_000, 102_000, -20.0, False, 9.0)])
    e = out[0][1]
    assert e.scores["audio"] == 0.0 and e.triggers == ["laugh"] and e.confidence == "normal"


def test_voice_spike_outside_window_gives_no_audio_points():
    # spike after the event ended, before it is closed by the merge gap: outside [start - 20 s, end]
    out, _, _ = run(span(106, 110), [VoiceSpike(115_000, 116_000, -20.0, True, 20.0)])
    e = out[0][1]
    assert e.scores["audio"] == 0.0 and e.triggers == ["laugh"]


def test_score_weights():
    out, _, _ = run(span(106, 110, msgs=7, authors=4, total=10, spike=4.0))
    assert out[0][1].scores == {"total": 5.0, "share": 1.5, "speed": 2.5, "audio": 0.0}


def test_score_caps_at_10():
    sp = VoiceSpike(101_000, 102_000, -20.0, True, 25.0)
    out, _, _ = run(span(106, 110, msgs=8, authors=6, spike=9.0), [sp])
    assert out[0][1].scores == {"total": 10.0, "share": 3.0, "speed": 5.0, "audio": 1.0}


def test_scores_take_the_event_maxima():
    frames = {**span(106, 108, total=8, spike=2.0), **span(108, 110, msgs=6, authors=6, total=8, spike=3.5)}
    out, _, _ = run(frames)
    e = out[0][1]
    assert e.scores == {"total": 4.8, "share": 1.9, "speed": 1.9, "audio": 0.0}
    assert e.signals["triggerShare"] == 0.75 and e.signals["chatSpike"] == 3.5


def test_fast_chat_keeps_the_event_open():
    frames = {**span(106, 108), **{t: tf(t, msgs=0, authors=0, spike=2.0) for t in range(108, 112)}}
    out, _, _ = run(frames)
    assert len(out) == 1 and out[0][1].end_ms == 112_000


def test_nothing_fires_during_warmup():
    out, near, _ = run(span(10, 20), [VoiceSpike(15_000, 16_000, -10.0, True, 20.0)], until=100)
    assert out == []
    assert near and near[0].missing == ["warm"]


def test_cold_chat_frame_does_not_fire():
    out, near, _ = run(span(106, 110, warm=False))
    assert out == [] and near[0].missing == ["warm"]


def test_events_merge_within_gap():
    out, _, _ = run({**span(106, 110), **span(118, 122, react=4, msgs=4)})
    assert len(out) == 1
    e = out[0][1]
    assert e.end_ms == 122_000 and e.trigger_time_ms == 106_000
    assert e.triggers == ["laugh"]  # 4x4 laughs vs 4x4 reactions over the event


def test_events_beyond_gap_are_separate():
    out, _, _ = run({**span(106, 110), **span(121, 125)})
    assert len(out) == 2


def test_event_longer_than_max_is_closed():
    out, _, _ = run(span(70, 200), until=210)
    assert out
    assert all(e.end_ms - e.start_ms <= 60_000 for _, e in out)


def test_flush_returns_open_event_and_callback():
    marks = []
    asm = EventAssembler(DEFAULTS, on_chat_spike=marks.append)
    out, _, asm = run(span(106, 110), until=108, asm=asm)
    assert out == [] and marks == [106_000, 107_000, 108_000]
    evs = asm.flush()
    assert len(evs) == 1 and evs[0].to_json()["type"] == "event"
    assert set(evs[0].to_json()["scores"]) == {"total", "share", "speed", "audio"}
    assert asm.flush() == []


def test_set_epoch_returns_the_open_event_instead_of_dropping_it():
    out, _, asm = run(span(106, 110), until=108)
    assert out == []
    evs = asm.set_epoch(1, 0)
    assert len(evs) == 1 and evs[0].epoch == 0
    assert asm.epoch == 1 and asm.flush() == []


def test_set_epoch_start_ms_shifts_warmup():
    asm = EventAssembler(DEFAULTS)
    asm.set_epoch(1, 100_000)
    out, _, _ = run(span(106, 110), asm=asm)
    assert out == []


def test_on_chat_spike_exception_is_logged(caplog):
    def boom(_t):
        raise RuntimeError("callback failed")

    asm = EventAssembler(DEFAULTS, on_chat_spike=boom)
    with caplog.at_level("WARNING", logger="hl_detector"):
        run(span(106, 110), until=108, asm=asm)
    assert any("callback failed" in r.getMessage() or "callback failed" in str(r.exc_info) for r in caplog.records)


def test_open_event_survives_reconfigure_and_is_scored_with_new_values():
    asm = EventAssembler(DEFAULTS)
    frames = span(70, 75, msgs=6, authors=6, total=10, spike=4.0)  # q = 0.6
    out, _, _ = run(frames, until=72, asm=asm)
    assert out == [] and asm._cur is not None
    asm.reconfigure(overlay(DEFAULTS, {"score": {"shareFull": 0.6}}))
    out, _, _ = run_from(73, frames, until=140, asm=asm)
    assert len(out) == 1 and out[0][1].scores["share"] == 3.0  # the old shareFull 0.9 would give 0.8
    assert out[0][1].trigger_time_ms == 70_000


def test_reconfigure_changes_the_trigger_from_the_next_tick():
    asm = EventAssembler(DEFAULTS)
    frames = span(100, 110, msgs=4, authors=4, total=10)  # q = 0.4 < 0.5
    out, near, _ = run(frames, until=104, asm=asm)
    assert out == [] and near and near[0].missing == ["share"]
    asm.reconfigure(overlay(DEFAULTS, {"chat": {"minTriggerShare": 0.3}}))
    out, _, _ = run_from(105, frames, until=140, asm=asm)
    assert len(out) == 1 and out[0][1].trigger_time_ms == 105_000


def test_conditions_name_what_is_missing():
    asm = EventAssembler(DEFAULTS)
    assert asm.conditions(70_000, tf(70, msgs=5, authors=1)) == {"warm": True, "spike": True, "messages": True, "authors": False, "share": True, "fired": False}
    assert asm.conditions(10_000, tf(10))["warm"] is False


def test_preview_scores_a_firing_second():
    asm = EventAssembler(DEFAULTS)
    assert asm.preview(tf(70, msgs=7, authors=4, total=10, spike=4.0), 15.0) == {"total": 5.5, "share": 1.5, "speed": 2.5, "audio": 0.5}


def test_preview_of_a_second_that_does_not_fire_has_only_audio():
    asm = EventAssembler(DEFAULTS)
    assert asm.preview(tf(70, msgs=1, authors=1, total=1, spike=1.6), 15.0) == {"total": 1.5, "share": 0.0, "speed": 0.0, "audio": 0.5}


def test_open_state_follows_the_event():
    asm = EventAssembler(DEFAULTS)
    assert asm.open_state(65_000) is None
    asm.on_tick(70_000, tf(70, authors=4), [], lambda lo, hi: [])
    s70 = asm.open_state(70_000)
    assert s70["startMs"] == 62_000 and s70["chatOpen"] is True and s70["lowConfidence"] is True
    asm.on_tick(71_000, tf(71, authors=4), [], lambda lo, hi: [])
    assert asm.open_state(71_000)["durationMs"] == s70["durationMs"] + 1000
    assert set(s70["score"]) == {"total", "share", "speed", "audio"}
    for sec in range(72, 100):
        asm.on_tick(sec * 1000, quiet(sec), [], lambda lo, hi: [])
    assert asm.open_state(99_000) is None


def test_preview_with_degenerate_score_ranges_does_not_divide_by_zero():
    cfg = overlay(DEFAULTS, {"score": {"spikeFull": 1, "audioFullDb": 10, "shareFull": 0.05}})
    asm = EventAssembler(cfg)
    assert asm.preview(tf(70, msgs=4, authors=4, spike=4.0), 15.0) == {"total": 10.0, "share": 3.0, "speed": 5.0, "audio": 1.0}
    assert asm.preview(tf(70, msgs=0, authors=0, spike=0.5), 5.0) == {"total": 1.0, "share": 0.0, "speed": 0.0, "audio": 0.0}


def test_spike_without_composition_does_not_fire():
    out, near, _ = run(span(106, 110, msgs=4, authors=3, total=20, spike=3.0))
    assert out == [] and near[0].missing == ["share"]


def test_composition_without_spike_does_not_fire():
    out, near, _ = run(span(106, 110, msgs=4, authors=3, total=5, spike=1.7))
    assert out == [] and near[0].missing == ["spike"]
    assert near[0].values == {"spike": 1.7, "messages": 5, "triggerMessages": 4, "triggerAuthors": 3, "triggerShare": 0.8}


def test_composition_far_below_spike_is_silent():
    out, near, _ = run(span(106, 110, msgs=4, authors=3, total=5, spike=1.2))
    assert out == [] and near == []


def test_audio_does_not_change_firing():
    sp = VoiceSpike(101_000, 102_000, -20.0, True, 20.0)
    quiet_chat = span(106, 110, msgs=4, authors=3, total=20, spike=1.2)
    assert run(quiet_chat, [sp])[0] == []
    plain, _, _ = run(span(106, 110))
    loud, _, _ = run(span(106, 110), [sp])
    assert (plain[0][1].trigger_time_ms, plain[0][1].end_ms) == (loud[0][1].trigger_time_ms, loud[0][1].end_ms)
    assert plain[0][1].scores["audio"] == 0.0 and loud[0][1].scores["audio"] == 1.0


def test_tail_seconds_do_not_raise_share():
    frames = {**span(106, 108, msgs=4, authors=3, total=8), 108: tf(108, msgs=1, authors=1, total=1, spike=1.6)}
    out, _, _ = run(frames)
    e = out[0][1]
    assert e.end_ms == 109_000  # the tail second still extends the event
    assert e.signals["triggerShare"] == 0.5 and e.scores["share"] == 0.0


def test_empty_window_has_zero_share_and_never_fires():
    asm = EventAssembler(DEFAULTS)
    c = asm.conditions(70_000, tf(70, msgs=0, authors=0, total=0, spike=5.0))
    assert c["share"] is False and c["fired"] is False
