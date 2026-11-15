"""Twitch chat source over anonymous IRC-over-WebSocket."""
import asyncio
import logging
import random
import time
from typing import AsyncIterator, Callable, Optional, Protocol

log = logging.getLogger(__name__)

IRC_URL = "wss://irc-ws.chat.twitch.tv:443"
BACKOFF_S = (1, 2, 5, 10, 30)


class ChatSource(Protocol):
    async def messages(self) -> AsyncIterator[tuple]:
        """Yield (wall_ms, user_id, text)."""
        ...


def _parse_tags(raw: str) -> dict:
    out = {}
    for part in raw.split(";"):
        k, _, v = part.partition("=")
        out[k] = v
    return out


def parse_privmsg(line: str, now_ms: Optional[int] = None) -> Optional[tuple]:
    """'@tags :nick!nick@host PRIVMSG #chan :text' -> (wall_ms, user_id, text); None for anything else."""
    try:
        s = (line or "").rstrip("\r\n")
        tags: dict = {}
        if s.startswith("@"):
            raw, _, s = s.partition(" ")
            tags = _parse_tags(raw[1:])
        if not s.startswith(":"):
            return None
        prefix, _, rest = s[1:].partition(" ")
        command, _, rest = rest.partition(" ")
        if command != "PRIVMSG":
            return None
        _, sep, text = rest.partition(" :")
        if not sep:
            return None
        nick = prefix.split("!", 1)[0]
        user = tags.get("user-id") or nick
        ts = tags.get("tmi-sent-ts")
        if ts and ts.isdigit():
            wall = int(ts)
        else:
            wall = int(time.time() * 1000) if now_ms is None else int(now_ms)
        return wall, user, text
    except Exception:
        return None


class TwitchIrc:
    def __init__(self, channel: str, on_status: Callable[[str], None], url: str = IRC_URL):
        self.channel = channel.lstrip("#").lower()
        self.on_status = on_status
        self.url = url
        self._status: Optional[str] = None

    def _set(self, status: str) -> None:
        if status != self._status:
            self._status = status
            try:
                self.on_status(status)
            except Exception:
                log.exception("on_status failed")

    async def messages(self) -> AsyncIterator[tuple]:
        import websockets

        attempt = 0
        while True:
            try:
                async with websockets.connect(self.url, max_size=2**20) as ws:
                    nick = "justinfan%05d" % random.randint(0, 99999)
                    await ws.send("CAP REQ :twitch.tv/tags")
                    await ws.send("NICK " + nick)
                    await ws.send("JOIN #" + self.channel)
                    async for raw in ws:
                        if isinstance(raw, bytes):
                            raw = raw.decode("utf-8", "replace")
                        for line in raw.split("\r\n"):
                            if not line:
                                continue
                            if line.startswith("PING"):
                                await ws.send("PONG" + line[4:])
                                continue
                            if " 001 " in line:
                                attempt = 0
                                self._set("connected")
                                continue
                            msg = parse_privmsg(line)
                            if msg is not None:
                                yield msg
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("Чат Twitch: соединение потеряно: %s", e)
            self._set("disconnected")
            delay = BACKOFF_S[min(attempt, len(BACKOFF_S) - 1)]
            attempt += 1
            await asyncio.sleep(delay)
