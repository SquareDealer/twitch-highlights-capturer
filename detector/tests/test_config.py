import json

from hl_detector.config import DEFAULTS, load_config


def test_load_config_ignores_unknown_keys(tmp_path):
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"detector": {"chat": {"someOldKey": 3}}, "password": "x"}), encoding="utf-8")
    cfg = load_config(str(p))
    assert "someOldKey" not in cfg["chat"]
    assert cfg["chat"]["windowS"] == 5


def test_defaults_have_new_keys():
    assert DEFAULTS["chat"]["minTriggerShare"] == 0.05
    assert DEFAULTS["score"]["spikeFull"] == 6
