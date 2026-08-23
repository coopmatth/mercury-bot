"""The client prices jobs locally so the total is right with no signal, which
means the rate table exists twice. This test fails the moment they disagree."""
import json
import re
from pathlib import Path

import pytest

from mercury.config import BASE_DIR
from mercury.rates import (AERIAL_ITEM, AERIAL_OVERAGE_RATE, AERIAL_TIER_1_MAX,
                           AERIAL_TIER_1_PRICE, AERIAL_TIER_2_MAX,
                           AERIAL_TIER_2_PRICE, PAY_RATES)

APP_JS = (BASE_DIR / "static" / "js" / "app.js").read_text()


def _js_rates() -> dict:
    block = re.search(r"export const RATES = \{(.*?)\};", APP_JS, re.S)
    assert block, "RATES table not found in static/js/app.js"
    rates = {}
    for name, value in re.findall(r"""['"](.+?)['"]\s*:\s*([\d.]+)""", block.group(1)):
        rates[name] = float(value)
    return rates


def test_flat_rates_match_the_server():
    assert _js_rates() == PAY_RATES


def test_aerial_item_name_matches():
    match = re.search(r"export const AERIAL_ITEM = '(.+?)';", APP_JS)
    assert match and match.group(1) == AERIAL_ITEM


@pytest.mark.parametrize("literal,expected", [
    (AERIAL_TIER_1_MAX, 300),
    (AERIAL_TIER_2_MAX, 600),
    (AERIAL_TIER_1_PRICE, 75.0),
    (AERIAL_TIER_2_PRICE, 150.0),
    (AERIAL_OVERAGE_RATE, 0.5),
])
def test_server_aerial_constants_are_what_the_client_hardcodes(literal, expected):
    """aerialPrice() in app.js encodes these numbers inline; if the server's
    change, the JS must be updated in the same commit."""
    assert literal == expected


def test_client_aerial_function_still_has_the_tier_shape():
    body = re.search(r"export function aerialPrice\(feet\) \{(.*?)\n\}", APP_JS, re.S)
    assert body, "aerialPrice not found in static/js/app.js"
    source = body.group(1)
    assert "ft <= 300" in source and "return 75.0" in source
    assert "ft <= 600" in source and "return 150.0" in source
    assert "(ft - 600) * 0.5" in source
