"""TR-36: idf prior smoothing.

The optional global prior stabilises idf while the live corpus is small and
fades to exactly zero influence at N = PRIOR_FADE_N live profiles — so the
scoring contract at N >= 30 is bit-identical to the legacy formula (well
inside the 2% shift bound), while a near-empty live corpus is pulled toward
the global distribution instead of assigning every node maximal idf.
"""

from __future__ import annotations

import math

from presence.matching import PRIOR_FADE_N, Corpus


def legacy_idf(size: int, n: int) -> float:
    return math.sqrt(math.log(1.0 + size / (1.0 + n)))


def test_no_prior_is_bit_identical_to_legacy() -> None:
    c = Corpus(5, {"a": 2, "b": 5})
    assert c.idf("a") == legacy_idf(5, 2)
    assert c.idf("b") == legacy_idf(5, 5)
    assert c.idf("unseen") == legacy_idf(5, 0)


def test_prior_fades_to_zero_at_fade_n() -> None:
    prior = {"common": 900, "rare": 3}
    for size in (PRIOR_FADE_N, PRIOR_FADE_N + 1, PRIOR_FADE_N * 4):
        c = Corpus(size, {"common": size, "rare": 1})
        c.set_prior(prior, 1000)
        # w == 0 → exactly the legacy value, far inside the 2% bound
        assert c.idf("common") == legacy_idf(size, size)
        assert c.idf("rare") == legacy_idf(size, 1)


def test_prior_pull_toward_global_distribution_at_small_n() -> None:
    prior_df = {"common": 900, "rare": 3}
    live = Corpus(2, {"common": 2, "rare": 1})
    live.set_prior(prior_df, 1000)

    plain = Corpus(2, {"common": 2, "rare": 1})

    # exact blended values
    w = (PRIOR_FADE_N - 2) / PRIOR_FADE_N
    s = w * PRIOR_FADE_N
    expected_common = math.sqrt(math.log(1.0 + (2 + s) / (1.0 + 2 + s * (900 / 1000))))
    assert live.idf("common") == expected_common
    expected_rare = math.sqrt(math.log(1.0 + (2 + s) / (1.0 + 1 + s * (3 / 1000))))
    assert live.idf("rare") == expected_rare

    # the pull is toward the prior's verdict: with the global distribution
    # saying 900:3, the rare/common idf ratio widens dramatically versus what
    # the tiny live corpus alone would conclude
    blended_ratio = live.idf("rare") / live.idf("common")
    plain_ratio = plain.idf("rare") / plain.idf("common")
    assert blended_ratio > plain_ratio

    # and the blended common-node value lands near the prior's own idf
    prior_only_common = math.sqrt(math.log(1.0 + PRIOR_FADE_N / (1.0 + PRIOR_FADE_N * 0.9)))
    assert abs(live.idf("common") - prior_only_common) < 0.05


def test_empty_live_corpus_with_prior_equals_prior_idf_at_fade_n() -> None:
    prior_df = {"x": 250}
    c = Corpus(0, {})
    c.set_prior(prior_df, 1000)
    # N = 0 → w = 1, S = 30: idf is exactly the prior's own idf at size 30
    expected = math.sqrt(math.log(1.0 + PRIOR_FADE_N / (1.0 + PRIOR_FADE_N * 0.25)))
    assert c.idf("x") == expected


def test_unseen_node_with_no_prior_entry_uses_zero_p0() -> None:
    c = Corpus(1, {})
    c.set_prior({"something_else": 500}, 1000)
    w = (PRIOR_FADE_N - 1) / PRIOR_FADE_N
    s = w * PRIOR_FADE_N
    expected = math.sqrt(math.log(1.0 + (1 + s) / (1.0 + 0.0)))
    assert c.idf("ghost") == expected


def test_clear_prior_restores_legacy_behaviour() -> None:
    c = Corpus(3, {"a": 1})
    c.set_prior({"a": 10}, 100)
    assert c.idf("a") != legacy_idf(3, 1)
    c.clear_prior()
    assert c.idf("a") == legacy_idf(3, 1)
