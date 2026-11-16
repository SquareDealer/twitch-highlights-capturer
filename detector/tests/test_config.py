import json

import pytest

from hl_detector.config import DEFAULTS, load_config, overlay, unsafe_pattern


def test_load_config_ignores_unknown_keys(tmp_path):
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"detector": {"chat": {"someOldKey": 3}}, "password": "x"}), encoding="utf-8")
    cfg = load_config(str(p))
    assert "someOldKey" not in cfg["chat"]
    assert cfg["chat"]["windowS"] == 5


def test_defaults_have_new_keys():
    assert DEFAULTS["chat"]["minTriggerShare"] == 0.05
    assert DEFAULTS["score"]["spikeFull"] == 6


def test_load_config_ignores_removed_keys(tmp_path):
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"detector": {"chat": {"laughSpike": 3}, "weights": {"C": 1}}}), encoding="utf-8")
    cfg = load_config(str(p))
    assert "laughSpike" not in cfg["chat"] and "weights" not in cfg
    assert cfg["chat"]["minTriggerMessages"] == 3


def test_old_trigger_keys_are_gone_from_defaults():
    old = {"minMessages", "minAuthors", "laughSpike", "laughShare", "massSpike", "massMinMessages", "massMinAuthors",
           "massReactionShare"}
    assert not old & set(DEFAULTS["chat"])
    assert "weights" not in DEFAULTS
    assert DEFAULTS["audio"]["triggerDb"] == 15  # VoiceSpike.strong still uses audio.trigger*


def test_overlay_replaces_known_keys_only():
    out = overlay(DEFAULTS, {"chat": {"minTriggerShare": 0.2, "nope": 1}, "weights": {}})
    assert out["chat"]["minTriggerShare"] == 0.2 and "nope" not in out["chat"] and "weights" not in out
    assert DEFAULTS["chat"]["minTriggerShare"] == 0.05  # base unchanged


@pytest.mark.parametrize("bad", [None, [], {"chat": 5}, {"chat": {"windowS": "5"}}, {"chat": {"windowS": True}},
                                 {"chat": {"windowS": float("nan")}}, {"chat": {"laughWords": [1]}},
                                 {"chat": {"laughWords": "x"}}])
def test_overlay_rejects_wrong_shapes(bad):
    with pytest.raises(ValueError):
        overlay(DEFAULTS, bad)


def test_unsafe_pattern():
    assert [unsafe_pattern(p) for p in ["^(a+)+$", "(ab)*", "(a){2,}", r"(.)\1"]] == [True] * 4
    assert [unsafe_pattern(p) for p in ["^pog(gers|champ)?$", "^[ах]*ха[ах]*$", r"^\d+$"]] == [False] * 3


@pytest.mark.parametrize("section,key", [("chat", "windowS"), ("chat", "baselineS"), ("chat", "activeWindowS"),
                                         ("chat", "alpha"), ("audio", "baselineS")])
def test_overlay_rejects_non_positive_windows_and_alpha(section, key):
    for bad in (0, -1):
        with pytest.raises(ValueError):
            overlay(DEFAULTS, {section: {key: bad}})


def test_many_adjacent_unbounded_quantifiers_are_unsafe():
    assert unsafe_pattern("^[ах]*[ах]*[ах]*[ах]*[ах]*[ах]*[ах]*$") is True
    assert unsafe_pattern("^a+b{2,}c*d+$") is True  # four: {n,} counts too
    assert unsafe_pattern(r"^\*\+\*\+a+$") is False  # escaped ones do not count


def test_every_default_pattern_is_safe():
    assert not unsafe_pattern("^[ах]*ха[ах]*$")
    assert [p for p in DEFAULTS["chat"]["laughWords"] + DEFAULTS["chat"]["reactionWords"] if unsafe_pattern(p)] == []
