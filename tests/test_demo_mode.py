"""Demo mode's guarantees are safety properties, so they get tested.

Config.DEMO is resolved at import time, so these run the checks in a
subprocess with the environment actually set — the same way the sandbox
really starts.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from mercury.config import BASE_DIR


def run_in_demo(code: str, data_dir: str) -> dict:
    """Execute `code` in a fresh interpreter with demo mode on."""
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=BASE_DIR,
        env={"PATH": "/usr/bin:/bin:/usr/local/bin", "MERCURY_DEMO": "1",
             "MERCURY_DATA_DIR": data_dir, "SECRET_KEY": "test",
             "PYTHONPATH": str(BASE_DIR)},
        capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


@pytest.fixture()
def data_dir():
    with tempfile.TemporaryDirectory() as tmp:
        yield tmp


def test_demo_uses_a_separate_database_and_never_the_real_one(data_dir):
    out = run_in_demo("""
import json
from mercury.config import Config
print(json.dumps({"db": str(Config.DB_PATH), "demo": Config.DEMO}))
""", data_dir)
    assert out["demo"] is True
    assert out["db"].endswith("demo/mercury-demo.db")
    assert "demo" in out["db"]


# Text in a ReportLab PDF lives inside compressed content streams, so reading
# it back needs decompression rather than a plain byte search. zlib is stdlib,
# which keeps the test suite installable from requirements.txt alone.
PDF_TEXT_SNIPPET = r"""
import base64, re, zlib

def pdf_text(path):
    # ReportLab writes content streams as /ASCII85Decode then /FlateDecode.
    # Try the whole chain, then the individual filters, then the raw bytes.
    decoders = (
        lambda d: zlib.decompress(base64.a85decode(d, adobe=True)),
        lambda d: zlib.decompress(d),
        lambda d: base64.a85decode(d, adobe=True),
        lambda d: d,
    )
    out = []
    for chunk in re.findall(rb"stream\r?\n(.*?)endstream", path.read_bytes(), re.S):
        chunk = chunk.strip()
        for decode in decoders:
            try:
                out.append(decode(chunk).decode("latin-1"))
                break
            except Exception:
                continue
    return "\n".join(out)
"""

PERSONAL_DETAILS = ("Matthew Cooper", "Lagrange", "310-7482",
                    "coopmatth", "Ritchie", "Congressional")


def test_pdf_text_extraction_actually_sees_the_text(ctx):
    """Guard the guard: prove the detector below can find a name in a PDF,
    so a passing leak test means something."""
    from mercury.config import Config
    from mercury.invoicing import build_mercury_invoice
    from mercury.models import save_job, week_bounds

    namespace = {}
    exec(PDF_TEXT_SNIPPET, namespace)

    start, end = week_bounds()
    save_job({"work_date": start.isoformat(), "items": {"Installation": 1}})
    invoice = build_mercury_invoice(start, end)

    text = namespace["pdf_text"](Config.EXPORT_DIR / invoice["filename"])
    assert Config.TECH_NAME in text, "extraction failed — the leak test would be vacuous"


def test_demo_never_renders_personal_details(data_dir):
    """A sandbox invoice must not carry someone's name, home address or phone."""
    out = run_in_demo(PDF_TEXT_SNIPPET + """
import json
from mercury import create_app
from mercury.config import Config
from mercury.invoicing import build_mercury_invoice
from mercury.models import week_bounds

app = create_app()
with app.app_context():
    start, end = week_bounds()
    invoice = build_mercury_invoice(start, end)
    text = pdf_text(Config.EXPORT_DIR / invoice["filename"])
print(json.dumps({"text": text, "tech": Config.TECH_NAME}))
""", data_dir)

    assert out["tech"] == "Alex Rivera"
    for personal in PERSONAL_DETAILS:
        assert personal not in out["text"], f"{personal} leaked into a demo invoice"


def test_demo_writes_email_to_disk_instead_of_sending(data_dir):
    """Even with SMTP credentials present, demo mode must not connect."""
    out = run_in_demo("""
import json, smtplib
from mercury import create_app
from mercury.config import Config

# Credentials that would work, and a tripwire on the SMTP client.
Config.SENDER_EMAIL = "real@example.com"
Config.EMAIL_PASSWORD = "app-password"
def explode(*a, **k):
    raise AssertionError("demo mode opened an SMTP connection")
smtplib.SMTP = explode

app = create_app()
client = app.test_client()
response = client.post("/api/email/personal")
captured = sorted(p.name for p in Config.OUTBOX_DIR.glob("*.eml"))
print(json.dumps({"status": response.status_code,
                  "body": response.get_json(), "captured": captured}))
""", data_dir)

    assert out["status"] == 200
    assert out["body"]["demo"] is True
    assert "not sent" in out["body"]["message"].lower()
    assert len(out["captured"]) == 1


def test_demo_seeds_sample_work_on_first_run(data_dir):
    out = run_in_demo("""
import json
from mercury import create_app
app = create_app()
client = app.test_client()
summary = client.get("/api/summary").get_json()
jobs = client.get("/api/jobs?all=1").get_json()["jobs"]
print(json.dumps({"weekly": summary["weekly"], "week_jobs": summary["job_count"],
                  "total_jobs": len(jobs)}))
""", data_dir)

    assert out["total_jobs"] > 10          # roughly two weeks of work
    assert out["week_jobs"] >= 6           # the current week is worth looking at
    assert out["weekly"] > 0


def test_seeding_refuses_to_run_outside_demo_mode(ctx):
    """The guard that keeps sample data out of a real database."""
    from mercury import demo
    with pytest.raises(RuntimeError, match="demo mode"):
        demo.seed()
    with pytest.raises(RuntimeError, match="demo mode"):
        demo.reset()


def test_demo_reset_route_is_refused_outside_demo_mode(client):
    response = client.post("/settings/demo-reset", follow_redirects=True)
    assert response.status_code == 200
    assert b"only available in demo mode" in response.data
