"""Detector configuration: defaults mirror src/service/config.ts defaultConfig().detector."""
import copy
import json

DEFAULTS: dict = {
    "chat": {
        "windowS": 5, "baselineS": 300, "alpha": 1, "minMessages": 8, "minAuthors": 5,
        "laughSpike": 3, "laughShare": 0.3, "massSpike": 6, "massMinMessages": 15, "massMinAuthors": 10,
        "massReactionShare": 0.2, "repeatShare": 0.6, "endSpike": 1.5,
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
    "weights": {"C": 0.35, "E": 0.25, "U": 0.2, "A": 0.2},
}


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in over.items():
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
