"""Detector process: binary PCM/control frames on stdin, JSON lines on stdout."""
import argparse
import asyncio
import io
import json
import logging
import queue
import sys
import threading
import time
from typing import Optional

from .audio import AudioAnalyzer
from .chat import ChatAnalyzer, ChatMessage, bad_patterns
from .config import load_config, overlay
from .events import EventAssembler
from .irc import ChatSource, TwitchIrc
from .protocol import FRAME_JSON, FRAME_PCM, emit, read_frames

log = logging.getLogger("hl_detector")

BYTES_PER_MS = 32  # 16 kHz * 2 bytes
TICK_MS = 1000
HEARTBEAT_MS = 5000
POLL_S = 0.2


def _reader(stdin, q: queue.Queue) -> None:
    try:
        for kind, body in read_frames(stdin):
            q.put(("pcm", body) if kind == FRAME_PCM else ("ctl", body) if kind == FRAME_JSON else ("skip", None))
    except Exception:
        log.exception("Сбой чтения stdin")
    q.put(("eof", None))


def _chat_thread(chat: ChatSource, q: queue.Queue) -> None:
    async def run() -> None:
        try:
            async for wall_ms, user, text in chat.messages():
                q.put(("chat", (int(wall_ms), user, text)))
        except Exception as e:
            log.warning("Чат недоступен: %s", e)
            q.put(("status", "disconnected"))

    try:
        asyncio.run(run())
    except Exception:
        log.exception("Сбой потока чата")


def _int(v) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def main(argv=None, stdin=None, stdout=None, chat: Optional[ChatSource] = None, vad=None, clock=None) -> int:
    ap = argparse.ArgumentParser(prog="hl_detector")
    ap.add_argument("--channel", default="")
    ap.add_argument("--config", required=True)
    ap.add_argument("--no-chat", action="store_true")
    args = ap.parse_args(argv)

    if stdin is None:
        stdin = sys.stdin.buffer
    if stdout is None:
        stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", newline="\n", write_through=True)
    clock = clock or (lambda: int(time.time() * 1000))
    cfg = load_config(args.config)
    if vad is None:
        from .vad import SileroVad

        vad = SileroVad()

    q: queue.Queue = queue.Queue()
    chat_status = {"v": None}

    def on_status(s: str) -> None:
        q.put(("status", s))

    if chat is None and not args.no_chat and args.channel:
        chat = TwitchIrc(args.channel, on_status)
    chat_t = None
    if chat is not None and not args.no_chat:
        chat_t = threading.Thread(target=_chat_thread, args=(chat, q), daemon=True)
        chat_t.start()
    threading.Thread(target=_reader, args=(stdin, q), daemon=True).start()

    # current settings: the file config with the last accepted `config` frame laid over it
    conf = {"cfg": cfg, "version": None, "warm_ms": int(cfg["events"]["warmupS"]) * 1000}
    analyzer = {"chat": ChatAnalyzer(cfg)}
    audio = AudioAnalyzer(cfg["audio"], vad)
    asm = EventAssembler(cfg, on_chat_spike=lambda t: analyzer["chat"].mark_spike(t))
    # fed: stream position in bytes since the epoch's t=0 (starts at the epoch frame's startMs); start: startMs
    st = {"fed": 0, "offset": None, "last": None, "start": 0}
    pending = bytearray()

    def send_events(evs) -> None:
        for ev in evs:
            emit(ev.to_json(), stdout)

    def tick(t: int) -> None:
        frame = analyzer["chat"].tick(t)
        spikes = audio.spikes()
        evs, near = asm.on_tick(t, frame, spikes, audio.recent_spikes)
        fr = st["last"]
        voice = max((float(s.delta_db) for s in audio.recent_spikes(t - int(asm.e["voiceWindowS"] * 1000), t)),
                    default=0.0)
        detail = {
            "configVersion": conf["version"] or 0, "sinceStartMs": t - st["start"],
            "chat": {
                "messages": frame.messages, "authors": frame.authors, "baseline": round(frame.baseline, 3),
                "spike": round(frame.spike, 3), "triggerMessages": frame.trigger_messages,
                "triggerAuthors": frame.trigger_authors, "laughMessages": frame.laugh_messages,
                "reactionMessages": frame.reaction_messages, "triggerShare": round(frame.trigger_share, 3),
            },
            "conditions": asm.conditions(t, frame),
            "audio": {
                "db": round(fr.db, 3), "baselineDb": round(fr.base_db, 3), "deltaDb": round(fr.delta_db, 3),
                "vad": round(fr.vad, 3), "warm": fr.warm, "spiking": audio.spiking,
            } if fr else {"db": 0.0, "baselineDb": 0.0, "deltaDb": 0.0, "vad": 0.0, "warm": False, "spiking": False},
            "score": asm.preview(frame, voice),
            "event": asm.open_state(t),
        }
        emit({
            "type": "signals", "epoch": asm.epoch, "tMs": t,
            "chatSpike": round(frame.spike, 3), "laughShare": round(frame.laugh_share, 3),
            "messages": frame.messages, "triggerShare": round(frame.trigger_share, 3),
            "triggerMessages": frame.trigger_messages,
            "deltaDb": round(fr.delta_db, 3) if fr else 0.0,
            "vad": round(fr.vad, 3) if fr else 0.0, "warm": t - st["start"] >= conf["warm_ms"],
            "detail": detail,
        }, stdout)
        send_events(evs)
        for n in near:
            emit({"type": "nearmiss", "epoch": asm.epoch, "tMs": n.t_ms, "kind": n.kind, "missing": n.missing,
                  "values": n.values}, stdout)

    def feed(body: bytes) -> None:
        pending.extend(body)
        while True:
            next_t = (st["fed"] // (BYTES_PER_MS * TICK_MS) + 1) * TICK_MS
            need = next_t * BYTES_PER_MS - st["fed"]
            if len(pending) < need:
                break
            audio.feed(bytes(pending[:need]))
            del pending[:need]
            st["fed"] += need
            frames = audio.frames()
            if frames:
                st["last"] = frames[-1]
            tick(next_t)
        if pending:
            audio.feed(bytes(pending))
            st["fed"] += len(pending)
            pending.clear()
            frames = audio.frames()
            if frames:
                st["last"] = frames[-1]

    def reset_epoch(epoch: int, start_ms: int) -> None:
        send_events(asm.set_epoch(epoch, start_ms))  # the open event of the old epoch is flushed, not lost
        audio.reset(start_ms)
        analyzer["chat"] = ChatAnalyzer(conf["cfg"])
        pending.clear()
        st.update(fed=start_ms * BYTES_PER_MS, offset=None, last=None, start=start_ms)

    def apply_config(msg: dict) -> None:
        """Lay the frame's settings over the file config and apply them without resetting any state.
        All or nothing: a wrong or unappliable frame is refused, the previous settings stay."""
        version = msg.get("version")
        try:
            if not isinstance(version, int) or isinstance(version, bool):
                raise ValueError("version: ожидалось целое число")
            new = overlay(cfg, msg.get("detector"))
            warm_ms = int(new["events"]["warmupS"]) * 1000
            bad = bad_patterns(new["chat"]["laughWords"]) + bad_patterns(new["chat"]["reactionWords"])
            old = conf["cfg"]
            try:
                audio.reconfigure(new["audio"])
                asm.reconfigure(new)
                analyzer["chat"].reconfigure(new)  # last: it is atomic itself, the other two revert exactly
            except Exception:
                audio.reconfigure(old["audio"])
                asm.reconfigure(old)
                raise
        except Exception as e:
            log.warning("Кадр config отклонён: %s", e)
            emit({"type": "config", "version": version, "badPatterns": [], "error": str(e) or type(e).__name__}, stdout)
            return
        conf.update(cfg=new, version=version, warm_ms=warm_ms)
        emit({"type": "config", "version": version, "badPatterns": bad}, stdout)

    def resync(t_ms: int) -> None:
        """PCM up to t_ms was dropped upstream: jump the clock over the gap (never backwards)."""
        if t_ms * BYTES_PER_MS <= st["fed"]:
            return
        pending.clear()
        audio.skip_to(t_ms)
        st["fed"] = t_ms * BYTES_PER_MS

    def set_status(s: str) -> None:
        if s != chat_status["v"]:
            chat_status["v"] = s
            emit({"type": "status", "chat": s}, stdout)

    def handle(kind: str, val) -> bool:
        """Returns False to stop."""
        if kind == "pcm":
            feed(val)
            audio_ms = st["fed"] // BYTES_PER_MS
            off = clock() - audio_ms
            st["offset"] = off if st["offset"] is None else min(st["offset"], off)
        elif kind == "ctl":
            try:
                msg = json.loads(val.decode("utf-8"))
            except Exception:
                log.warning("Некорректный управляющий кадр")
                return True
            t = msg.get("type") if isinstance(msg, dict) else None
            if t == "epoch":
                reset_epoch(_int(msg.get("epoch")), max(0, _int(msg.get("startMs"))))
            elif t == "resync":
                resync(_int(msg.get("tMs")))
            elif t == "config":
                apply_config(msg)
            elif t == "stop":
                return False
        elif kind == "chat":
            wall, user, text = val
            if st["offset"] is not None:
                analyzer["chat"].add(ChatMessage(t_ms=wall - st["offset"], user=user, text=text))
        elif kind == "status":
            set_status(val)
        elif kind == "eof":
            return False
        return True

    next_hb = clock() + HEARTBEAT_MS
    emit({"type": "heartbeat"}, stdout)
    running = True
    while running:
        try:
            kind, val = q.get(timeout=POLL_S)
            running = handle(kind, val)
        except queue.Empty:
            pass
        now = clock()
        if now >= next_hb:
            emit({"type": "heartbeat"}, stdout)
            next_hb = now + HEARTBEAT_MS

    if chat_t is not None:
        chat_t.join(timeout=0.3)
    while True:  # late status reports
        try:
            kind, val = q.get_nowait()
        except queue.Empty:
            break
        if kind == "status":
            set_status(val)
    send_events(asm.flush())
    return 0


if __name__ == "__main__":
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sys.exit(main())
