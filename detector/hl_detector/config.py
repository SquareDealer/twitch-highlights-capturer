"""Detector configuration: defaults mirror src/service/config.ts defaultConfig().detector."""
import copy
import json
import math
import re

_UNSAFE = re.compile(r"\)[*+{]|\\[1-9]")

DEFAULTS: dict = {
    "chat": {
        "windowS": 5, "baselineS": 300, "alpha": 1, "activeWindowS": 300, "minActive": 10,
        "minTriggerMessages": 3, "minTriggerAuthors": 2, "minTriggerShare": 0.05, "endSpike": 1.5, "repeatShare": 0.6,
        "laughWords": [
            "^[ах]*ха[ах]*$", "^[ah]*ha[ah]*$", "^ору+$", "^ржу+$", "^ло+л$", "^ке+к$", "^пхп+$", "^хд+$",
            "^lo+l$", "^lmao+$", "^xd+$", "^kekw$", "^lul$", "^omegalul$", "^icant$", "😂", "🤣",
        ],
        "reactionWords": [
            "^не+т+$", "^что+$", "^wtf+$", "^f$", "^pog(gers|champ)?$", "^о+мг$", "^omg+$", "^жесть$", "^капец$", "^rip$",
        ],
        "interactiveWords": ["^\\d+$", "^[+\\-]+$", "^да+$", "^нет$", "^[a-dа-г]$", "^yes$", "^no$"],
    },
    "audio": {
        "blockMs": 100, "baselineS": 45, "spikeDb": 10, "spikeVad": 0.5, "spikeMinMs": 300,
        "triggerDb": 15, "triggerVad": 0.7, "triggerMinMs": 500,
    },
    "events": {"warmupS": 60, "lookbackS": 20, "chatLagS": 8, "voiceWindowS": 20, "mergeGapS": 10, "maxEventS": 60},
    "score": {"shareFull": 0.3, "spikeFull": 6, "audioMinDb": 10, "audioFullDb": 20},
}


# values that would only fail later, at tick time
_POSITIVE = (("chat", "windowS"), ("chat", "baselineS"), ("chat", "activeWindowS"), ("chat", "alpha"),
             ("audio", "baselineS"))


def _merge(base: dict, over: dict) -> dict:
    """Merge `over` onto `base`, ignoring keys absent from `base` (stale user config)."""
    out = copy.deepcopy(base)
    for k, v in over.items():
        if k not in base:
            continue
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def load_config(path: str) -> dict:
    """Read the service JSON config and return its `detector` field merged over DEFAULTS."""
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    over = raw.get("detector", {}) if isinstance(raw, dict) else {}
    return _merge(DEFAULTS, over if isinstance(over, dict) else {})


def unsafe_pattern(p: str) -> bool:
    """A quantified group or a backreference: may backtrack catastrophically, never run."""
    return _UNSAFE.search(p) is not None


def _number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def overlay(base: dict, detector) -> dict:
    """`base` with the `detector` sections laid over it; keys absent from `base` are ignored.

    Raises ValueError when the shape is wrong: `detector` or a section is not a dict, a number is not
    a finite int/float (bool is not a number), a list is not a list of strings."""
    if not isinstance(detector, dict):
        raise ValueError("detector: ожидался объект")
    out = copy.deepcopy(base)
    for name, section in detector.items():
        if name not in base:
            continue
        if not isinstance(section, dict):
            raise ValueError(f"{name}: ожидался объект")
        for key, v in section.items():
            if key not in base[name]:
                continue
            if isinstance(base[name][key], list):
                if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
                    raise ValueError(f"{name}.{key}: ожидался список строк")
                out[name][key] = list(v)
            elif _number(v):
                out[name][key] = v
            else:
                raise ValueError(f"{name}.{key}: ожидалось конечное число")
    for name, key in _POSITIVE:
        if out[name][key] <= 0:
            raise ValueError(f"{name}.{key}: ожидалось число больше нуля")
    return out
