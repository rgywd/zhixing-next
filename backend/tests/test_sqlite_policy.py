import pytest

from zhixing_next.sqlite_policy import safe_journal_mode


@pytest.mark.parametrize("version,expected", [
    ((3, 50, 4), "DELETE"), ((3, 51, 2), "DELETE"), ((3, 51, 3), "WAL"),
    ((3, 50, 7), "WAL"), ((3, 44, 6), "WAL"), ((3, 45, 0), "DELETE"), ((3, 52, 0), "WAL"),
])
def test_known_patched_versions(version, expected):
    assert safe_journal_mode(version) == expected
