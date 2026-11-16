"""Chat features: normalization, token classes, robust per-second baseline, repeat classes."""
import re
import statistics
from dataclasses import dataclass
from typing import Optional

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


def normalize(text: str) -> str:
    s = _RUN.sub(lambda m: m.group(1) * 2, (text or "").strip().lower())
    return s[:40]


def _chat_cfg(cfg: dict) -> dict:
    return cfg.get("chat", cfg) if isinstance(cfg, dict) else cfg


def _compiled(words) -> list:
    key = tuple(words)
    got = _RE_CACHE.get(key)
    if got is None:
        got = []
        for w in key:
            try:
                got.append(re.compile(w.replace(r"\d", "[0-9]"), re.IGNORECASE))
            except re.error:
                pass
        _RE_CACHE[key] = got
    return got


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
        self.cfg = cfg
        self.c = _chat_cfg(cfg)
        ev = cfg.get("events", {}) if isinstance(cfg, dict) else {}
        self.warm_ms = int(ev.get("warmupS", 60)) * 1000
        self.win_ms = int(self.c["windowS"] * 1000)
        self.base_ms = int(self.c["baselineS"] * 1000)
        self._msgs: list = []  # (t_ms, user, norm, classes)
        self._base: list = []  # (t_ms, messages, authors)
        self._active: list = []  # (t_ms, user) over activeWindowS
        self.active_ms = int(self.c["activeWindowS"] * 1000)
        self._marks: list = []
        self._first_tick: Optional[int] = None

    def add(self, msg: ChatMessage) -> None:
        try:
            norm = normalize(msg.text)
            classes = {classify(t, self.cfg) for t in _tokens(msg.text) if t}
        except Exception:
            norm, classes = "", set()
        self._msgs.append((int(msg.t_ms), msg.user, norm, classes))
        self._active.append((int(msg.t_ms), msg.user))

    def mark_spike(self, t_ms: int) -> None:
        self._marks.append(int(t_ms))

    def _excluded(self, t: int) -> bool:
        return any(abs(t - m) < self.win_ms for m in self._marks)

    def _repeat_class(self, norms: list) -> Optional[str]:
        n = len(norms)
        if n < self.c["minMessages"]:
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
            self._first_tick = now_ms
        warm = now_ms - self._first_tick >= self.warm_ms
        self._base.append((now_ms, n, a))

        laugh = sum(1 for m in win if "laugh" in m[3])
        react = sum(1 for m in win if "reaction" in m[3])
        react_only = sum(1 for m in win if "reaction" in m[3] and "laugh" not in m[3])
        trig = [m for m in win if "laugh" in m[3] or "reaction" in m[3]]
        trig_authors = len({m[1] for m in trig})
        acut = now_ms - self.active_ms
        self._active = [x for x in self._active if x[0] >= acut]
        active = max(int(self.c["minActive"]), len({u for t, u in self._active if t <= now_ms}))
        return ChatFrame(
            t_ms=now_ms, messages=n, authors=a,
            spike=(n + alpha) / (mb + alpha), author_spike=(a + alpha) / (ab + alpha),
            rarity=rar, author_rarity=arar,
            laugh_share=laugh / n if n else 0.0, reaction_share=react / n if n else 0.0,
            repeat_class=self._repeat_class([m[2] for m in win]), warm=warm,
            trigger_messages=len(trig), trigger_authors=trig_authors,
            laugh_messages=laugh, reaction_messages=react_only,
            active_authors=active, trigger_share=trig_authors / active,
        )
