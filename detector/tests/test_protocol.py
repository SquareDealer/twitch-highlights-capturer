import io
import json

from hl_detector.protocol import emit, read_frames, write_frame


def test_read_frames_roundtrip_and_truncated_tail():
    buf = io.BytesIO()
    write_frame(buf, 0, b"\x01\x02\x03\x04")
    write_frame(buf, 1, b'{"type":"stop"}')
    write_frame(buf, 0, b"")
    data = buf.getvalue()
    assert list(read_frames(io.BytesIO(data))) == [(0, b"\x01\x02\x03\x04"), (1, b'{"type":"stop"}'), (0, b"")]
    # cut mid-body and mid-header: complete frames survive, tail is dropped
    cut = data[: 5 + 4 + 5 + 15 + 3]
    assert list(read_frames(io.BytesIO(cut))) == [(0, b"\x01\x02\x03\x04"), (1, b'{"type":"stop"}')]
    cut = data[: 5 + 4 + 5 + 7]
    assert list(read_frames(io.BytesIO(cut))) == [(0, b"\x01\x02\x03\x04")]


def test_emit_writes_one_json_line():
    out = io.StringIO()
    emit({"type": "status", "chat": "привет"}, out)
    assert out.getvalue().endswith("\n")
    assert json.loads(out.getvalue()) == {"type": "status", "chat": "привет"}
