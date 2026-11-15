"""Trigger rules, event assembly and the ranking score."""
from dataclasses import dataclass, field
from typing import Callable, Optional

from .chat import ChatFrame
from .audio import VoiceSpike

NEAR_MISS_EVERY_MS = 10_000
LOW_AUDIO_ONLY_FACTOR = 0.7


@dataclass
class Event:
    epoch: int
    start_ms: int
    end_ms: int
    trigger_time_ms: int
    estimated_event_ms: int
    uncertainty_ms: int
    triggers: list
    confidence: str
    scores: dict
    signals: dict

    def to_json(self) -> dict:
        return {
            "type": "event",
            "epoch": self.epoch,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
            "triggerTimeMs": self.trigger_time_ms,
            "estimatedEventMs": self.estimated_event_ms,
            "uncertaintyMs": self.uncertainty_ms,
            "triggers": list(self.triggers),
            "confidence": self.confidence,
            "scores": dict(self.scores),
            "signals": dict(self.signals),
        }


@dataclass
class NearMiss:
    t_ms: int
    kind: str  # 'chat' | 'audio'
    missing: list
    values: dict


@dataclass
class _Open:
    epoch: int
    est: int
    unc: int
    trigger_time: int
    end_ms: int
    lagged: bool = False
    chat_seen: bool = False
    chat_open: bool = False
    triggers: list = field(default_factory=list)
    rarity: float = 0.0
    author_rarity: float = 0.0
    laugh: float = 0.0
    reaction: float = 0.0
    chat_spike: float = 0.0
    delta_db: float = 0.0


def _delta(sp: VoiceSpike) -> float:
    return float(sp.delta_db)


class EventAssembler:
    def __init__(self, cfg: dict, on_chat_spike: Optional[Callable[[int], None]] = None):
        self.c = cfg["chat"]
        self.e = cfg["events"]
        self.w = cfg["weights"]
        self.on_chat_spike = on_chat_spike
        self.epoch = 0
        self.start_ms = 0
        self._reset()

    def _reset(self) -> None:
        self._cur: Optional[_Open] = None
        self._last_nm: dict = {}

    def set_epoch(self, epoch: int, start_ms: int = 0) -> None:
        """start_ms: stream time the detector starts at within the epoch (warmup counts from it)."""
        self.epoch = int(epoch)
        self.start_ms = int(start_ms)
        self._reset()

    # ---- helpers ----
    def _score(self, o: _Open, audio_only: bool) -> dict:
        C = min(1.0, max(0.0, o.rarity))
        U = min(1.0, max(0.0, o.author_rarity))
        E = min(1.0, max(0.0, o.laugh))
        A = min(1.0, max(0.0, o.delta_db / 20.0))
        S = self.w["C"] * C + self.w["E"] * E + self.w["U"] * U + self.w["A"] * A
        if audio_only:
            S *= LOW_AUDIO_ONLY_FACTOR
        return {k: round(v, 3) for k, v in (("S", S), ("C", C), ("E", E), ("U", U), ("A", A))}

    def _finish(self, o: _Open, end_ms: Optional[int] = None) -> Event:
        start = max(0, o.est)
        end = o.end_ms if end_ms is None else end_ms
        audio_only = not o.chat_seen
        low = audio_only or o.lagged
        return Event(
            epoch=o.epoch, start_ms=start, end_ms=max(end, start), trigger_time_ms=o.trigger_time,
            estimated_event_ms=o.est, uncertainty_ms=o.unc, triggers=list(o.triggers),
            confidence="low" if low else "normal", scores=self._score(o, audio_only),
            signals={
                "chatSpike": round(o.chat_spike, 3), "laughShare": round(o.laugh, 3),
                "reactionShare": round(o.reaction, 3), "deltaDb": round(o.delta_db, 3),
            },
        )

    @staticmethod
    def _add(o: _Open, kind: str) -> None:
        if kind not in o.triggers:
            o.triggers.append(kind)

    def _chat_feed(self, o: _Open, f: ChatFrame) -> None:
        o.rarity = max(o.rarity, f.rarity)
        o.author_rarity = max(o.author_rarity, f.author_rarity)
        o.laugh = max(o.laugh, f.laugh_share)
        o.reaction = max(o.reaction, f.reaction_share)
        o.chat_spike = max(o.chat_spike, f.spike)

    def _nm_ok(self, kind: str, now: int) -> bool:
        last = self._last_nm.get(kind)
        if last is not None and now - last < NEAR_MISS_EVERY_MS:
            return False
        self._last_nm[kind] = now
        return True

    # ---- main ----
    def on_tick(self, now_ms: int, frame: ChatFrame, new_spikes: list,
                recent_spikes: Callable[[int, int], list]) -> tuple:
        now = int(now_ms)
        c, e = self.c, self.e
        events: list = []
        near: list = []
        warm = now - self.start_ms >= int(e["warmupS"]) * 1000
        chat_warm = warm and frame.warm

        # audio triggers / near-miss
        audio_trig = [s for s in new_spikes if s.strong] if warm else []
        if warm:
            if not audio_trig and self._cur is None:
                for s in new_spikes:
                    if not s.strong and self._nm_ok("audio", now):
                        near.append(NearMiss(now, "audio", ["strong"], {"peakDb": round(s.peak_db, 2)}))

        # chat triggers
        voice = []
        if chat_warm:
            voice = list(new_spikes) + recent_spikes(now - int(e["voiceWindowS"] * 1000), now)
        rc = frame.repeat_class
        laugh = (
            chat_warm and frame.spike >= c["laughSpike"] and frame.messages >= c["minMessages"]
            and frame.authors >= c["minAuthors"] and frame.laugh_share >= c["laughShare"] and rc != "interactive"
        )
        mass_base = (
            chat_warm and frame.spike >= c["massSpike"] and frame.messages >= c["massMinMessages"]
            and frame.authors >= c["massMinAuthors"] and rc != "interactive"
        )
        mass_ok = bool(voice) if rc == "unknown" else (frame.reaction_share >= c["massReactionShare"] or bool(voice))
        mass = mass_base and mass_ok
        chat_kinds = (["laugh"] if laugh else []) + (["mass"] if mass else [])

        if chat_kinds and self.on_chat_spike:
            try:
                self.on_chat_spike(now)
            except Exception:
                pass

        # chat near-miss
        if not chat_kinds and frame.spike >= c["laughSpike"] and frame.messages >= c["minMessages"] \
                and frame.authors >= c["minAuthors"] and not (self._cur and self._cur.chat_open):
            missing = []
            if not chat_warm:
                missing.append("warm")
            if frame.laugh_share < c["laughShare"]:
                missing.append("laugh_share")
            if rc == "interactive":
                missing.append("interactive")
            if frame.spike < c["massSpike"]:
                missing.append("mass_spike")
            elif chat_warm and not mass_ok and rc != "interactive":
                missing.append("voice")
            if missing and self._nm_ok("chat", now):
                near.append(NearMiss(now, "chat", missing, {
                    "spike": round(frame.spike, 3), "messages": frame.messages, "authors": frame.authors,
                    "laughShare": round(frame.laugh_share, 3), "reactionShare": round(frame.reaction_share, 3),
                    "repeatClass": rc,
                }))

        # open / extend
        o = self._cur
        if chat_kinds:
            if o is None:
                lo = now - int(e["lookbackS"] * 1000)
                anchors = recent_spikes(lo, now)
                if anchors:
                    est, unc, lag = min(s.start_ms for s in anchors), 2000, False
                else:
                    est, unc, lag = now - int(e["chatLagS"] * 1000), int(e["lookbackS"] * 1000), True
                o = self._cur = _Open(self.epoch, est, unc, now, now, lagged=lag)
                for s in anchors:
                    o.delta_db = max(o.delta_db, _delta(s))
            o.chat_seen = True
            o.chat_open = True
            o.end_ms = max(o.end_ms, now)
            for k in chat_kinds:
                self._add(o, k)
            self._chat_feed(o, frame)
        elif o is not None and o.chat_open:
            if frame.spike >= c["endSpike"]:
                o.end_ms = max(o.end_ms, now)
                self._chat_feed(o, frame)
            else:
                o.chat_open = False
                o.end_ms = max(o.end_ms, now)

        for s in audio_trig:
            if o is None:
                o = self._cur = _Open(self.epoch, s.start_ms, 1000, now, s.end_ms)
            self._add(o, "audio")
            o.end_ms = max(o.end_ms, s.end_ms)
            o.delta_db = max(o.delta_db, _delta(s))
        if o is not None and warm:
            for s in new_spikes:
                o.delta_db = max(o.delta_db, _delta(s))

        # close
        if o is not None:
            max_ms = int(e["maxEventS"] * 1000)
            start = max(0, o.est)
            span_end = now if o.chat_open else o.end_ms
            if span_end - start > max_ms:
                events.append(self._finish(o, start + max_ms))
                self._cur = None
            elif not o.chat_open and now >= o.end_ms + int(e["mergeGapS"] * 1000):
                events.append(self._finish(o))
                self._cur = None
        return events, near

    def flush(self) -> list:
        o, self._cur = self._cur, None
        return [self._finish(o)] if o is not None else []
