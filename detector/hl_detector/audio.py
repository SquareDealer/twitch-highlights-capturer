"""Audio features: 100 ms loudness blocks, robust voiced baseline, voice spikes."""
import math
import statistics
from collections import deque
from dataclasses import dataclass
from typing import Optional

import numpy as np

SAMPLE_RATE = 16000
MIN_BASE_BLOCKS = 50
KEEP_SPIKES_MS = 120_000


@dataclass
class VoiceSpike:
    start_ms: int
    end_ms: int
    peak_db: float
    strong: bool


@dataclass
class AudioFrame:
    t_ms: int
    db: float
    delta_db: float
    vad: float
    warm: bool


def _audio_cfg(cfg: dict) -> dict:
    return cfg.get("audio", cfg) if isinstance(cfg, dict) else cfg


class AudioAnalyzer:
    def __init__(self, cfg: dict, vad):
        self.c = _audio_cfg(cfg)
        self.vad = vad
        self.block_ms = int(self.c["blockMs"])
        self.block_n = SAMPLE_RATE * self.block_ms // 1000
        self.base_ms = int(self.c["baselineS"] * 1000)
        self._reset_state()

    def _reset_state(self) -> None:
        self._buf = b""
        self._samples = 0  # blocks emitted * block_n
        self._base: deque = deque()  # (t_ms, db)
        self._frames: list = []
        self._new_spikes: list = []
        self._recent: list = []
        self._cur: Optional[dict] = None

    def reset(self) -> None:
        self._reset_state()
        self.vad.reset()

    def feed(self, pcm: bytes) -> None:
        self._buf += pcm
        step = self.block_n * 2
        n = len(self._buf) // step
        if n == 0:
            return
        arr = np.frombuffer(self._buf[: n * step], dtype="<i2").astype(np.float32) / 32768.0
        self._buf = self._buf[n * step:]
        for i in range(n):
            self._block(arr[i * self.block_n:(i + 1) * self.block_n])

    def _block(self, x: np.ndarray) -> None:
        t = self._samples * 1000 // SAMPLE_RATE
        self._samples += len(x)
        rms = float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if len(x) else 0.0
        db = max(-90.0, 20.0 * math.log10(rms)) if rms > 0 else -90.0
        try:
            p = float(self.vad.prob(x))
        except Exception:
            p = 0.0

        cut = t - self.base_ms
        while self._base and self._base[0][0] <= cut:
            self._base.popleft()
        warm = len(self._base) >= MIN_BASE_BLOCKS
        delta = db - statistics.median(b[1] for b in self._base) if warm else 0.0
        self._frames.append(AudioFrame(t_ms=t, db=db, delta_db=delta, vad=p, warm=warm))

        c = self.c
        hot = warm and delta >= c["spikeDb"] and p >= c["spikeVad"]
        if hot:
            cur = self._cur
            if cur is None:
                cur = self._cur = {"start": t, "n": 0, "peak": db, "run": 0, "best": 0}
            cur["n"] += 1
            cur["peak"] = max(cur["peak"], db)
            if delta >= c["triggerDb"] and p >= c["triggerVad"]:
                cur["run"] += 1
                cur["best"] = max(cur["best"], cur["run"])
            else:
                cur["run"] = 0
            return
        self._close(t)
        if p >= c["spikeVad"]:
            self._base.append((t, db))

    def _close(self, t: int) -> None:
        cur, self._cur = self._cur, None
        if cur is None:
            return
        if cur["n"] * self.block_ms < self.c["spikeMinMs"]:
            return
        sp = VoiceSpike(
            start_ms=cur["start"], end_ms=cur["start"] + cur["n"] * self.block_ms, peak_db=cur["peak"],
            strong=cur["best"] * self.block_ms >= self.c["triggerMinMs"],
        )
        self._new_spikes.append(sp)
        self._recent.append(sp)
        lo = t - KEEP_SPIKES_MS
        self._recent = [s for s in self._recent if s.end_ms >= lo]

    def frames(self) -> list:
        out, self._frames = self._frames, []
        return out

    def spikes(self) -> list:
        out, self._new_spikes = self._new_spikes, []
        return out

    def recent_spikes(self, from_ms: int, to_ms: int) -> list:
        return [s for s in self._recent if s.end_ms >= from_ms and s.start_ms <= to_ms]
