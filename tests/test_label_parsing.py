"""Runs the JavaScript label-parsing tests as part of the normal suite.

The parsing that turns OCR text into the work-order template lives in
static/js/scanner.js, so its tests are JavaScript (tests/js/label-parsing.test.js)
and need node. This wrapper means `pytest` alone is enough to catch a
regression there, without making node a hard requirement for running the
Python suite on a machine that doesn't have it.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

JS_TEST = Path(__file__).parent / "js" / "label-parsing.test.js"


@pytest.mark.skipif(shutil.which("node") is None,
                    reason="node is not installed; run tests/js/label-parsing.test.js manually")
def test_equipment_labels_parse_to_the_right_device():
    result = subprocess.run(
        ["node", str(JS_TEST)], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, (
        "label parsing regressed — a photo's fields went to the wrong device:\n"
        f"{result.stdout}\n{result.stderr}")
