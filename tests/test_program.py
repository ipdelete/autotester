from autotester.program import parse_front_matter


def test_parse_front_matter_with_blocks():
    text = """---
model: gpt-5.5
gate: |
  set -e
  pytest
metric: |
  echo 'metric: 1'
count: 3
---
# Body
"""

    front, body = parse_front_matter(text)

    assert front["model"] == "gpt-5.5"
    assert front["gate"] == "set -e\npytest\n"
    assert front["metric"] == "echo 'metric: 1'\n"
    assert front["count"] == 3
    assert body == "# Body\n"
