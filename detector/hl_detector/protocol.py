"""stdin/stdout protocol: binary frames in, JSON lines out."""
import json
import math
import struct
from typing import BinaryIO, Iterator, TextIO

FRAME_PCM = 0
FRAME_JSON = 1
_HEADER = struct.Struct("<BI")


def _read_exact(stream: BinaryIO, n: int) -> bytes:
    chunks = []
    got = 0
    while got < n:
        b = stream.read(n - got)
        if not b:
            break
        chunks.append(b)
        got += len(b)
    return b"".join(chunks)


def read_frames(stream: BinaryIO) -> Iterator[tuple]:
    """Yield (type, body); a stream cut mid-frame ends iteration silently."""
    while True:
        head = _read_exact(stream, _HEADER.size)
        if len(head) < _HEADER.size:
            return
        kind, length = _HEADER.unpack(head)
        body = _read_exact(stream, length) if length else b""
        if len(body) < length:
            return
        yield kind, body


def write_frame(stream: BinaryIO, kind: int, body: bytes) -> None:
    stream.write(_HEADER.pack(kind, len(body)) + body)


def _finite(v):
    """NaN/Infinity are not JSON: Node's JSON.parse would drop the whole line. They become 0."""
    if isinstance(v, float):
        return v if math.isfinite(v) else 0
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_finite(x) for x in v]
    return v


def emit(obj: dict, out: TextIO) -> None:
    out.write(json.dumps(_finite(obj), ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n")
    out.flush()
