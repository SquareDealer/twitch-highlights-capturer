import math
import time

from hl_detector.chat import ChatAnalyzer, ChatMessage, bad_patterns, classify, normalize
from hl_detector.config import DEFAULTS, overlay

CFG = DEFAULTS


def feed(a, t0, n, text, users=None):
    for i in range(n):
        u = users[i] if users else f"u{i}"
        txt = text[i] if isinstance(text, list) else text
        a.add(ChatMessage(t0 + int(i * 5000 / max(n, 1)), u, txt))


def run_base(a, per_window, secs=120):
    """Steady chat: per_window messages inside every 5 s window, ticks each second."""
    for s in range(secs):
        t = s * 1000
        if s % 5 == 0:
            feed(a, t, per_window, "привет")
        a.tick(t + 999)


def test_small_chat_baseline_is_not_zero():
    a = ChatAnalyzer(CFG)
    last = None
    for s in range(0, 120):
        t = s * 1000
        if s % 4 == 0:
            a.add(ChatMessage(t, f"u{s}", "привет"))
        last = a.tick(t + 500)
        if s > 60:
            assert last.spike < 1.6


def test_spike_ratio_uses_alpha():
    a = ChatAnalyzer(CFG)
    for s in range(100):
        t = 1000 * s
        if s % 2 == 0:
            a.add(ChatMessage(t, f"u{s}", "x"))  # 2-3 per 5s window
        a.tick(t)
    # force baseline to exactly 2
    a._base = [(b[0], 2, 2) for b in a._base]
    now = 100_000
    a._msgs = []
    for i in range(11):
        a.add(ChatMessage(now - 100 - i, f"v{i}", "привет"))
    f = a.tick(now)
    assert f.messages == 11 and f.spike == 4.0


def test_laugh_share_counts_variants():
    a = ChatAnalyzer(CFG)
    feed(a, 0, 5, ["ахахах", "ХАХА", "KEKW", "ору", "привет"])
    assert a.tick(5000).laugh_share == 0.8


def test_reaction_share():
    a = ChatAnalyzer(CFG)
    feed(a, 0, 5, ["НЕЕЕЕТ", "wtf", "F", "что", "ок"])
    assert a.tick(5000).reaction_share == 0.8


def test_repeat_interactive():
    a = ChatAnalyzer(CFG)
    feed(a, 0, 10, ["1"] * 7 + ["a b", "хм", "ну"])
    assert a.tick(5000).repeat_class == "interactive"


def test_repeat_emotional():
    a = ChatAnalyzer(CFG)
    feed(a, 0, 8, ["НЕЕЕЕТ"] * 5 + ["WTF", "F", "АХАХАХ"])
    assert a.tick(5000).repeat_class == "emotional"


def test_repeat_unknown():
    a = ChatAnalyzer(CFG)
    feed(a, 0, 10, ["gta 6"] * 8 + ["x", "y"])
    assert a.tick(5000).repeat_class == "unknown"


def test_no_repeat_when_diverse():
    a = ChatAnalyzer(CFG)
    feed(a, 0, 10, [f"msg{i}" for i in range(10)])
    assert a.tick(5000).repeat_class is None


def test_plain_net_is_interactive_but_neeet_is_reaction():
    assert classify(normalize("нет"), CFG) == "interactive"
    assert classify(normalize("НЕЕЕЕТ"), CFG) == "reaction"
    assert classify("ору", CFG) == "laugh"
    assert classify("привет", CFG) == "unknown"


def test_normalize():
    assert normalize("  ХАААААХА ") == "хааха"
    assert normalize("ааааа") == "аа"
    assert len(normalize("ab" * 100)) == 40


def test_marked_spike_is_excluded_from_baseline():
    def build(mark):
        a = ChatAnalyzer(CFG)
        for s in range(60):
            t = s * 1000
            if s % 5 == 0:
                feed(a, t, 2, "привет")
            a.tick(t + 999)
        for s in range(60, 120):  # burst
            t = s * 1000
            feed(a, t, 30, "ХАХА") if s % 5 == 0 else None
            f = a.tick(t + 999)
            if mark:
                a.mark_spike(t + 999)
        return a.tick(120_999)

    assert build(True).spike > build(False).spike


def test_garbage_does_not_crash():
    a = ChatAnalyzer(CFG)
    for txt in ["", "а" * 500, "\udcff", "😂😂😂", "🔥🔥🔥", "x" * 2000, "ах" * 1000 + "я", "   "]:
        a.add(ChatMessage(1000, "u", txt))
    t = time.time()
    f = a.tick(2000)
    assert time.time() - t < 2
    assert f.messages == 8


def test_not_warm_before_60s():
    a = ChatAnalyzer(CFG)
    for s in range(30):
        f = a.tick(s * 1000)
    assert f.warm is False
    for s in range(30, 70):
        f = a.tick(s * 1000)
    assert f.warm is True


def test_classify_pathological_is_fast():
    t = time.time()
    assert classify("ах" * 30 + "!", CFG) == "unknown"
    assert classify("ah" * 30 + "!", CFG) == "unknown"
    assert time.time() - t < 0.5


def test_digits_ascii_only():
    assert classify("12", CFG) == "interactive"
    assert classify("١٢", CFG) == "unknown"


def _window(a, texts, now=100_000):
    for i, (u, t) in enumerate(texts):
        a.add(ChatMessage(now - 1000 - i, u, t))
    return a.tick(now)


def test_trigger_counts_laugh_and_reaction():
    a = ChatAnalyzer(CFG)
    f = _window(a, [("u0", "ахах"), ("u1", "KEKW"), ("u2", "НЕЕЕТ"), ("u3", "wtf"), ("u4", "привет"), ("u5", "1")])
    assert f.trigger_messages == 4
    assert f.laugh_messages == 2
    assert f.reaction_messages == 2
    assert f.trigger_authors == 4






def test_one_author_counts_once():
    a = ChatAnalyzer(CFG)
    f = _window(a, [("solo", "ахах")] * 5)
    assert f.trigger_messages == 5
    assert f.trigger_authors == 1


def test_interactive_is_not_trigger():
    a = ChatAnalyzer(CFG)
    f = _window(a, [(f"u{i}", "1") for i in range(10)])
    assert f.trigger_messages == 0
    assert f.trigger_share == 0.0


def cfg_with(**chat):
    return overlay(DEFAULTS, {"chat": chat})


def test_reconfigure_keeps_baseline_and_warmup():
    a = ChatAnalyzer(CFG)
    run_base(a, 6)
    base, first = list(a._base), a._first_tick
    a.reconfigure(cfg_with(minTriggerShare=0.2, endSpike=3))
    assert a._base == base and a._first_tick == first and a.tick(120_000).warm


def test_window_change_does_not_skew_spike():
    a = ChatAnalyzer(CFG)
    run_base(a, 6, secs=400)  # steady chat: 6 messages per 5 s
    before = a.tick(400_000).spike
    a.reconfigure(cfg_with(windowS=10))
    for s in range(401, 421):
        if s % 5 == 0:
            feed(a, s * 1000, 6, "привет")
        last = a.tick(s * 1000 + 999)
    assert 0.8 <= last.spike <= 1.25 and 0.8 <= before <= 1.25  # without the recompute it would be about 2


def test_window_shrink_does_not_halve_spike():
    a = ChatAnalyzer(cfg_with(windowS=10))
    run_base(a, 6, secs=400)  # the same steady chat: 12 messages per 10 s
    before = a.tick(400_000).spike
    a.reconfigure(cfg_with(windowS=5))
    for s in range(401, 421):
        if s % 5 == 0:
            feed(a, s * 1000, 6, "привет")
        last = a.tick(s * 1000 + 999)
    assert 0.8 <= last.spike <= 1.25 and 0.8 <= before <= 1.25  # without the recompute it would be about 0.5


def test_window_change_with_empty_or_short_history():
    a = ChatAnalyzer(CFG)
    a.reconfigure(cfg_with(windowS=20))  # no baseline at all
    f = a.tick(1000)
    assert math.isfinite(f.spike) and f.spike >= 0
    b = ChatAnalyzer(CFG)
    for s in range(3):
        b.add(ChatMessage(s * 1000, f"u{s}", "x"))
        b.tick(s * 1000)
    b.reconfigure(cfg_with(windowS=30))
    f = b.tick(3000)
    assert math.isfinite(f.spike) and f.spike >= 0


def test_new_dictionary_applies_to_new_messages_only():
    a = ChatAnalyzer(CFG)
    a.add(ChatMessage(0, "u1", "бугага"))
    a.reconfigure(cfg_with(laughWords=["^бугага$"]))
    a.add(ChatMessage(100, "u2", "бугага"))
    assert a.tick(1000).laugh_messages == 1




def test_unsafe_pattern_is_never_run_and_is_reported():
    words = ["^([ах]+)+$", "((", "^lol$"]
    assert bad_patterns(words) == ["^([ах]+)+$", "(("]
    a = ChatAnalyzer(cfg_with(laughWords=words))
    t0 = time.time()
    a.add(ChatMessage(0, "u", "ахахахахахахахахахахахахахахахахахахах!"))
    assert time.time() - t0 < 0.5




def test_pattern_with_a_quantifier_too_large_for_python_is_reported_not_raised():
    assert bad_patterns(["ха{99999999999}", "^lol$"]) == ["ха{99999999999}"]


def test_trigger_share_is_share_of_messages():
    a = ChatAnalyzer(CFG)
    f = _window(a, [("u0", "ахах"), ("u1", "KEKW"), ("u2", "НЕЕЕТ"), ("u3", "привет")])
    assert f.trigger_share == 0.75


def test_trigger_share_zero_on_empty_window():
    f = ChatAnalyzer(CFG).tick(100_000)
    assert f.messages == 0 and f.trigger_share == 0.0


def test_frame_reports_baseline():
    a = ChatAnalyzer(CFG); run_base(a, 6); f = a.tick(120_000)
    assert 5 <= f.baseline <= 7
