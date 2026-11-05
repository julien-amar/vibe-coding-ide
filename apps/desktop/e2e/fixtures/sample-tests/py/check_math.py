import pytest


def test_adds():
    assert 1 + 1 == 2


def test_fails_on_purpose():
    assert 2 * 2 == 5


class TestGroup:
    def test_inside_class(self):
        assert "vibe".startswith("v")


@pytest.mark.parametrize("n", [1, 2])
def test_param(n):
    assert n > 0


@pytest.mark.skip(reason="not yet")
def test_skipped():
    pass
