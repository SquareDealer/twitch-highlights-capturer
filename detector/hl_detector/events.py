"""Relative chat trigger, event assembly and the 1-10 score."""
import logging
from dataclasses import dataclass, field
from typing import Callable, Optional

from .chat import ChatFrame

log = logging.getLogger("hl_detector")

NEAR_MISS_EVERY_MS = 10_000


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
    kind: str  # 'chat'
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
    chat_open: bool = False
    spikes: dict = field(default_factory=dict)  # (start_ms, end_ms) -> VoiceSpike seen while the event was open
    laugh_messages: int = 0
    reaction_messages: int = 0
    chat_spike: float = 0.0
    trigger_share: float = 0.0
    trigger_messages: int = 0
    active_authors: int = 0
    laugh: float = 0.0
    reaction: float = 0.0


def _lin(x: float, a: float, b: float, top: float) -> float:
    return min(1.0, max(0.0, (x - a) / (b - a))) * top


class EventAssembler:
    def __init__(self, cfg: dict, on_chat_spike: Optional[Callable[[int], None]] = None):
        self.reconfigure(cfg)
        self.on_chat_spike = on_chat_spike
        self.epoch = 0
        self.start_ms = 0
        self._reset()

    def reconfigure(self, cfg: dict) -> None:
        """New settings from the next tick on; an open event is closed and scored with them."""
        self.c = cfg["chat"]
        self.e = cfg["events"]
        self.s = cfg["score"]

    def _reset(self) -> None:
        self._cur: Optional[_Open] = None
        self._last_nm: dict = {}

    def set_epoch(self, epoch: int, start_ms: int = 0) -> list:
        """start_ms: stream time the detector starts at within the epoch (warmup counts from it).

        Returns the event that was still open in the previous epoch (flushed, never dropped)."""
        evs = self.flush()
        self.epoch = int(epoch)
        self.start_ms = int(start_ms)
        self._reset()
        return evs

    # ---- helpers ----
    def _delta_db(self, o: _Open, start: int, end: int) -> float:
        """Largest voice spike over [start - voiceWindowS, end]."""
        lo = start - int(self.e["voiceWindowS"] * 1000)
        return max((float(sp.delta_db) for sp in o.spikes.values() if sp.end_ms >= lo and sp.start_ms <= end),
                   default=0.0)

    def _score(self, o: _Open, delta_db: float) -> dict:
        c, s = self.c, self.s
        share = round(_lin(o.trigger_share, c["minTriggerShare"], s["shareFull"], 5), 1)
        speed = round(_lin(o.chat_spike, 1, s["spikeFull"], 3), 1)
        audio = round(_lin(delta_db, s["audioMinDb"], s["audioFullDb"], 1), 1)
        total = round(min(10.0, 1 + share + speed + audio), 1)
        return {"total": total, "share": share, "speed": speed, "audio": audio}

    def _finish(self, o: _Open, end_ms: Optional[int] = None) -> Event:
        start = max(0, o.est)
        end = max(o.end_ms if end_ms is None else end_ms, start)
        delta_db = self._delta_db(o, start, end)
        scores = self._score(o, delta_db)
        triggers = ["laugh" if o.laugh_messages >= o.reaction_messages else "reaction"]
        if scores["audio"] > 0:
            triggers.append("audio")
        return Event(
            epoch=o.epoch, start_ms=start, end_ms=end, trigger_time_ms=o.trigger_time,
            estimated_event_ms=o.est, uncertainty_ms=o.unc, triggers=triggers,
            confidence="low" if o.lagged else "normal", scores=scores,
            signals={
                "chatSpike": round(o.chat_spike, 3), "triggerShare": round(o.trigger_share, 3),
                "triggerMessages": o.trigger_messages, "activeAuthors": o.active_authors,
                "laughShare": round(o.laugh, 3), "reactionShare": round(o.reaction, 3), "deltaDb": round(delta_db, 3),
            },
        )

    @staticmethod
    def _chat_feed(o: _Open, f: ChatFrame) -> None:
        o.laugh_messages += f.laugh_messages
        o.reaction_messages += f.reaction_messages
        o.chat_spike = max(o.chat_spike, f.spike)
        o.trigger_share = max(o.trigger_share, f.trigger_share)
        o.trigger_messages = max(o.trigger_messages, f.trigger_messages)
        o.active_authors = max(o.active_authors, f.active_authors)
        o.laugh = max(o.laugh, f.laugh_share)
        o.reaction = max(o.reaction, f.reaction_share)

    @staticmethod
    def _see(o: _Open, spikes) -> None:
        for sp in spikes:
            o.spikes[(sp.start_ms, sp.end_ms)] = sp

    def _nm_ok(self, kind: str, now: int) -> bool:
        last = self._last_nm.get(kind)
        if last is not None and now - last < NEAR_MISS_EVERY_MS:
            return False
        self._last_nm[kind] = now
        return True

    def conditions(self, now_ms: int, frame: ChatFrame) -> dict:
        """The trigger rule's parts for this frame: what holds and what is missing."""
        c, e = self.c, self.e
        warm = int(now_ms) - self.start_ms >= int(e["warmupS"]) * 1000 and frame.warm
        enough = frame.trigger_messages >= c["minTriggerMessages"]
        authors_ok = frame.trigger_authors >= c["minTriggerAuthors"]
        share_ok = frame.trigger_share >= c["minTriggerShare"]
        return {"warm": warm, "messages": enough, "authors": authors_ok, "share": share_ok,
                "fired": warm and enough and authors_ok and share_ok}

    def preview(self, frame: ChatFrame, delta_db: float) -> dict:
        """The score of this one second alone, by the same formula as an event's."""
        o = _Open(self.epoch, 0, 0, 0, 0, chat_spike=frame.spike, trigger_share=frame.trigger_share)
        return self._score(o, delta_db)

    def open_state(self, now_ms: int) -> Optional[dict]:
        """The open event as it stands now, or None."""
        o = self._cur
        if o is None:
            return None
        start = max(0, o.est)
        end = int(now_ms) if o.chat_open else o.end_ms
        return {"startMs": start, "durationMs": max(0, end - start), "chatOpen": o.chat_open,
                "lowConfidence": o.lagged, "score": self._score(o, self._delta_db(o, start, end))}

    # ---- main ----
    def on_tick(self, now_ms: int, frame: ChatFrame, new_spikes: list,
                recent_spikes: Callable[[int, int], list]) -> tuple:
        now = int(now_ms)
        c, e = self.c, self.e
        events: list = []
        near: list = []
        cond = self.conditions(now, frame)
        warm, enough, authors_ok, share_ok, fired = (cond[k] for k in ("warm", "messages", "authors", "share", "fired"))

        if fired and self.on_chat_spike:
            try:
                self.on_chat_spike(now)
            except Exception:
                log.exception("on_chat_spike failed")

        # near-miss: enough trigger messages, but something else is missing
        if enough and not fired and not (self._cur and self._cur.chat_open):
            missing = [k for k, ok in (("warm", warm), ("authors", authors_ok), ("share", share_ok)) if not ok]
            if self._nm_ok("chat", now):
                near.append(NearMiss(now, "chat", missing, {
                    "spike": round(frame.spike, 3), "triggerMessages": frame.trigger_messages,
                    "triggerAuthors": frame.trigger_authors, "activeAuthors": frame.active_authors,
                    "triggerShare": round(frame.trigger_share, 3),
                }))

        # open / extend
        o = self._cur
        if fired:
            if o is None:
                lo = now - int(e["lookbackS"] * 1000)
                anchors = recent_spikes(lo, now)
                if anchors:
                    est, unc, lag = min(s.start_ms for s in anchors), 2000, False
                else:
                    est, unc, lag = now - int(e["chatLagS"] * 1000), int(e["lookbackS"] * 1000), True
                o = self._cur = _Open(self.epoch, est, unc, now, now, lagged=lag)
                start = max(0, est)
                self._see(o, recent_spikes(start - int(e["voiceWindowS"] * 1000), now))
            o.chat_open = True
            o.end_ms = max(o.end_ms, now)
            self._chat_feed(o, frame)
        elif o is not None and o.chat_open:
            o.end_ms = max(o.end_ms, now)
            if frame.spike >= c["endSpike"]:
                self._chat_feed(o, frame)
            else:
                o.chat_open = False
        if o is not None:
            self._see(o, new_spikes)

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
