"""Chat features: normalization, token classes, robust per-second baseline, repeat classes."""
import bisect
import re
import statistics
from dataclasses import dataclass
from typing import Optional

from .config import unsafe_pattern

_RUN = re.compile(r"(.)\1{2,}", re.DOTALL)
_RE_CACHE: dict = {}


@dataclass
class ChatMessage:
    t_ms: int
    user: str
    text: str


@dataclass
class ChatFrame:
    t_ms: int
    messages: int
    authors: int
    spike: float
    author_spike: float
    rarity: float
    author_rarity: float
    laugh_share: float
    reaction_share: float
    repeat_class: Optional[str]
    warm: bool
    trigger_messages: int = 0
    trigger_authors: int = 0
    laugh_messages: int = 0
    reaction_messages: int = 0
    active_authors: int = 0
    trigger_share: float = 0.0
    baseline: float = 0.0  # median message count of the background windows
    active_authors_raw: int = 0  # active authors without the minActive floor


def normalize(text: str) -> str:
    s = _RUN.sub(lambda m: m.group(1) * 2, (text or "").strip().lower())
    return s[:40]


def _chat_cfg(cfg: dict) -> dict:
    return cfg.get("chat", cfg) if isinstance(cfg, dict) else cfg


def _compile(w: str):
    """The pattern compiled, or None if it does not compile or may backtrack catastrophically."""
    if unsafe_pattern(w):
        return None
    try:
        return re.compile(w.replace(r"\d", "[0-9]"), re.IGNORECASE)
    except Exception:  # re.error, but also OverflowError for a quantifier of 2**32-1 or more
        return None


def _compiled(words) -> list:
    key = tuple(words)
    got = _RE_CACHE.get(key)
    if got is None:
        got = [r for r in map(_compile, key) if r is not None]
        _RE_CACHE[key] = got
    return got


def bad_patterns(words) -> list:
    """Patterns that are skipped: they do not compile or are unsafe. In the order of `words`."""
    return [w for w in words if _compile(w) is None]


def _hit(token: str, words) -> bool:
    return any(r.search(token) for r in _compiled(words))


def classify(token: str, cfg) -> str:
    c = _chat_cfg(cfg)
    if _hit(token, c["laughWords"]):
        return "laugh"
    if token == "нет":  # plain "нет" is an answer to a poll, "неееет" is a reaction
        return "interactive"
    if _hit(token, c["reactionWords"]):
        return "reaction"
    if _hit(token, c["interactiveWords"]):
        return "interactive"
    return "unknown"


def _tokens(text: str) -> list:
    return [normalize(t) for t in (text or "").split()]


class ChatAnalyzer:
    def __init__(self, cfg: dict):
        self._apply(cfg)
        self._msgs: list = []  # (t_ms, user, norm, classes)
        self._base: list = []  # (t_ms, messages, authors)
        self._hist: list = []  # (t_ms, user) over max(activeWindowS, baselineS + windowS)
        self._hist_from: Optional[int] = None  # _hist holds every message from this time on
        self._marks: list = []
        self._first_tick: Optional[int] = None

    def _apply(self, cfg: dict) -> None:
        c = _chat_cfg(cfg)
        ev = cfg.get("events", {}) if isinstance(cfg, dict) else {}
        warm_ms = int(ev.get("warmupS", 60)) * 1000
        win_ms = int(c["windowS"] * 1000)
        base_ms = int(c["baselineS"] * 1000)
        active_ms = int(c["activeWindowS"] * 1000)
        self.cfg, self.c = cfg, c  # every value is computed above: a failure leaves the analyzer untouched
        self.warm_ms, self.win_ms, self.base_ms, self.active_ms = warm_ms, win_ms, base_ms, active_ms

    def reconfigure(self, cfg: dict) -> None:
        """New settings from the next message/tick on; nothing accumulated is dropped or reclassified.
        All or nothing: if the new settings cannot be applied the analyzer keeps the previous ones."""
        old = (self.cfg, self.c, self.warm_ms, self.win_ms, self.base_ms, self.active_ms)
        try:
            self._apply(cfg)
            if self.win_ms != old[3]:
                self._base = self._rebased(old[3])
        except Exception:
            self.cfg, self.c, self.warm_ms, self.win_ms, self.base_ms, self.active_ms = old
            raise

    def _rebased(self, old_win: int) -> list:
        """The baseline re-expressed for the new window: recounted from the history where it covers the
        whole new window, otherwise scaled by new/old window length."""
        new_win = self.win_ms
        ratio = new_win / old_win if old_win > 0 else 1.0
        hist = sorted(self._hist, key=lambda h: h[0])
        times = [h[0] for h in hist]
        out = []
        for t, n, a in self._base:
            lo = t - new_win
            if self._hist_from is not None and lo >= self._hist_from:
                win = hist[bisect.bisect_left(times, lo):bisect.bisect_right(times, t)]
                out.append((t, len(win), len({u for _, u in win})))
            else:
                out.append((t, n * ratio, a * ratio))
        return out

    def add(self, msg: ChatMessage) -> None:
        try:
            norm = normalize(msg.text)
            classes = {classify(t, self.cfg) for t in _tokens(msg.text) if t}
        except Exception:
            norm, classes = "", set()
        self._msgs.append((int(msg.t_ms), msg.user, norm, classes))
        self._hist.append((int(msg.t_ms), msg.user))

    def mark_spike(self, t_ms: int) -> None:
        self._marks.append(int(t_ms))

    def _excluded(self, t: int) -> bool:
        return any(abs(t - m) < self.win_ms for m in self._marks)

    def _repeat_class(self, norms: list) -> Optional[str]:
        n = len(norms)
        if n < self.c["minTriggerMessages"]:
            return None
        counts: dict = {}
        for s in norms:
            if s and len(s) <= 12:
                counts[s] = counts.get(s, 0) + 1
        if not counts:
            return None
        top, cnt = max(counts.items(), key=lambda kv: kv[1])
        if cnt / n < self.c["repeatShare"]:
            return None
        whole = classify(top, self.cfg)
        if whole in ("laugh", "reaction"):
            return "emotional"
        if whole == "interactive":
            return "interactive"
        toks = [classify(t, self.cfg) for t in top.split()]
        return "emotional" if any(k in ("laugh", "reaction") for k in toks) else "unknown"

    def tick(self, now_ms: int) -> ChatFrame:
        now_ms = int(now_ms)
        lo = now_ms - self.win_ms
        self._msgs = [m for m in self._msgs if m[0] >= lo]
        win = [m for m in self._msgs if m[0] <= now_ms]
        n = len(win)
        a = len({m[1] for m in win})
        alpha = self.c["alpha"]

        cut = now_ms - self.base_ms
        self._base = [b for b in self._base if b[0] > cut]
        self._marks = [m for m in self._marks if m > cut - self.win_ms]
        base = [b for b in self._base if not self._excluded(b[0])]
        if base:
            mb = statistics.median(b[1] for b in base)
            ab = statistics.median(b[2] for b in base)
            rar = sum(1 for b in base if b[1] < n) / len(base)
            arar = sum(1 for b in base if b[2] < a) / len(base)
        else:
            mb = ab = 0.0
            rar = arar = 0.0

        if self._first_tick is None:
            self._first_tick = self._hist_from = now_ms
        warm = now_ms - self._first_tick >= self.warm_ms
        self._base.append((now_ms, n, a))

        laugh = sum(1 for m in win if "laugh" in m[3])
        react = sum(1 for m in win if "reaction" in m[3])
        react_only = sum(1 for m in win if "reaction" in m[3] and "laugh" not in m[3])
        trig = [m for m in win if "laugh" in m[3] or "reaction" in m[3]]
        trig_authors = len({m[1] for m in trig})
        hcut = now_ms - max(self.active_ms, self.base_ms + self.win_ms)
        self._hist = [x for x in self._hist if x[0] >= hcut]
        self._hist_from = max(self._hist_from, hcut)
        acut = now_ms - self.active_ms
        raw_active = len({u for t, u in self._hist if acut <= t <= now_ms})
        active = max(int(self.c["minActive"]), raw_active)
        return ChatFrame(
            t_ms=now_ms, messages=n, authors=a,
            spike=(n + alpha) / (mb + alpha), author_spike=(a + alpha) / (ab + alpha),
            rarity=rar, author_rarity=arar,
            laugh_share=laugh / n if n else 0.0, reaction_share=react / n if n else 0.0,
            repeat_class=self._repeat_class([m[2] for m in win]), warm=warm,
            trigger_messages=len(trig), trigger_authors=trig_authors,
            laugh_messages=laugh, reaction_messages=react_only,
            active_authors=active, trigger_share=trig_authors / active,
            baseline=float(mb), active_authors_raw=raw_active,
        )
