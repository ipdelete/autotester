import pytest

from autotester.graphs import parse_metric_output


def test_parse_metric_output_accepts_plain_number():
    assert parse_metric_output("12\n") == 12


def test_parse_metric_output_accepts_metric_prefix():
    assert parse_metric_output("noise\nmetric: 2.5\n") == 2.5


def test_parse_metric_output_rejects_empty():
    with pytest.raises(ValueError):
        parse_metric_output("\n")
