import os

import numpy as np
import pytest

from hl_detector.vad import SileroVad, default_model_path

pytestmark = pytest.mark.skipif(not os.path.isfile(default_model_path()), reason="silero_vad.onnx не установлена")


def test_silence_is_not_speech():
    v = SileroVad()
    p = max(v.prob(np.zeros(1600, dtype=np.float32)) for _ in range(5))
    assert p < 0.3
