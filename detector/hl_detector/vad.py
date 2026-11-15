"""Voice activity detection: Vad protocol and a Silero (v5) ONNX implementation."""
import os
from typing import Optional, Protocol

import numpy as np

SAMPLE_RATE = 16000
_WINDOW = 512
_CONTEXT = 64


class Vad(Protocol):
    def prob(self, samples: np.ndarray) -> float:
        """float32 [-1,1], 16 kHz, ~100 ms -> speech probability 0..1."""

    def reset(self) -> None: ...


def default_model_path() -> str:
    env = os.environ.get("HL_VAD_MODEL")
    if env:
        return env
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "silero_vad.onnx")


class SileroVad:
    def __init__(self, model_path: Optional[str] = None):
        import onnxruntime as ort

        path = model_path or default_model_path()
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Не найдена модель VAD: {path}")
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        self._sess = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
        self._sr = np.array(SAMPLE_RATE, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros(_CONTEXT, dtype=np.float32)
        self._rest = np.zeros(0, dtype=np.float32)

    def prob(self, samples: np.ndarray) -> float:
        buf = np.concatenate([self._rest, np.asarray(samples, dtype=np.float32).reshape(-1)])
        best = 0.0
        pos = 0
        while pos + _WINDOW <= len(buf):
            win = buf[pos:pos + _WINDOW]
            x = np.concatenate([self._context, win])[None, :]
            out, self._state = self._sess.run(None, {"input": x, "state": self._state, "sr": self._sr})
            self._context = win[-_CONTEXT:]
            best = max(best, float(np.asarray(out).reshape(-1)[0]))
            pos += _WINDOW
        self._rest = buf[pos:].copy()
        return best
