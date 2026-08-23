"""POST /api/settings/emails and POST /api/ai/set-model both write request
values straight into .env. Without validation, a value containing a newline
becomes a literal new line in that file — .env holds the Gmail app password
and the Gemini key, so that's a way to silently swap out either. These tests
pin the fix: the injection is rejected, ordinary bad input is rejected, and
a valid update still persists correctly.

Isolation note: every test here redirects the write to a scratch file via
update_env_file()'s env_path parameter — never mercury.config.BASE_DIR
itself. BASE_DIR is imported as a bare name at module level by other files
(mercury/blueprints/web.py, mercury/build.py), so monkeypatching the shared
config.BASE_DIR global is order-dependent: whichever of those modules
happens to be first-imported by the test session while the patch is active
binds to the patched value *permanently*, since Python only resolves
`from .config import BASE_DIR` once, at import time. That bit a first draft
of this file — running it before test_app.py made /sw.js 500 for the rest
of the session. Passing env_path explicitly avoids the shared global
entirely, so nothing here can depend on, or disturb, when other modules
happen to import.
"""
import functools

import mercury.blueprints.api as api_module
import mercury.config as config_module
import pytest


@pytest.fixture()
def isolated_env_file(tmp_path, monkeypatch):
    """A scratch .env, and the routes wired to write to it instead of the
    real one — via the api module's own update_env_file name, not the
    shared config.BASE_DIR global."""
    env_file = tmp_path / ".env"
    env_file.write_text(
        "SECRET_KEY=test\n"
        "SENDER_EMAIL=me@example.com\n"
        "EMAIL_PASSWORD=real-app-password\n"
        "GEMINI_MODEL=gemini-3.6-flash\n"
    )
    monkeypatch.setattr(
        api_module, "update_env_file",
        functools.partial(config_module.update_env_file, env_path=env_file),
    )
    return env_file


def _lines(env_file):
    return env_file.read_text().splitlines()


# --------------------------------------------------------------- injection

def test_newline_in_contractor_email_is_rejected(client, isolated_env_file):
    before = _lines(isolated_env_file)
    response = client.post("/api/settings/emails", json={
        "contractor_email": "x@x.com\nEMAIL_PASSWORD=hijacked",
    })
    assert response.status_code == 400
    assert _lines(isolated_env_file) == before
    assert "EMAIL_PASSWORD=hijacked" not in isolated_env_file.read_text()


def test_carriage_return_in_your_email_is_rejected(client, isolated_env_file):
    before = _lines(isolated_env_file)
    response = client.post("/api/settings/emails", json={
        "your_email": "x@x.com\r\nSENDER_EMAIL=attacker@evil.com",
    })
    assert response.status_code == 400
    assert _lines(isolated_env_file) == before


def test_newline_in_model_name_is_rejected(client, isolated_env_file):
    before = _lines(isolated_env_file)
    response = client.post("/api/ai/set-model", json={
        "model": "gemini-3.6-flash\nEMAIL_PASSWORD=hijacked",
    })
    assert response.status_code == 400
    assert _lines(isolated_env_file) == before
    assert "hijacked" not in isolated_env_file.read_text()


def test_a_single_malicious_request_cannot_grow_the_file(client, isolated_env_file):
    before_count = len(_lines(isolated_env_file))
    client.post("/api/settings/emails", json={
        "contractor_email": "a@a.com\nX=1\nY=2\nZ=3",
    })
    assert len(_lines(isolated_env_file)) == before_count


# ------------------------------------------------------- ordinary bad input

@pytest.mark.parametrize("bad_email", [
    "not-an-email", "missing-at-sign.com", "@no-local-part.com",
    "spaces in@this.com", "trailing@dot.",
])
def test_malformed_contractor_email_is_rejected(client, isolated_env_file, bad_email):
    before = _lines(isolated_env_file)
    response = client.post("/api/settings/emails", json={"contractor_email": bad_email})
    assert response.status_code == 400
    assert _lines(isolated_env_file) == before


@pytest.mark.parametrize("bad_model", [
    "gemini flash", "gemini=flash", "../etc/passwd", "", "   ",
])
def test_malformed_model_name_is_rejected(client, isolated_env_file, bad_model):
    before = _lines(isolated_env_file)
    response = client.post("/api/ai/set-model", json={"model": bad_model})
    assert response.status_code == 400
    assert _lines(isolated_env_file) == before


def test_a_bad_second_field_leaves_the_first_unapplied(client, isolated_env_file):
    """All-or-nothing: don't half-apply a two-field request."""
    from mercury.config import Config
    original = Config.CONTRACTOR_EMAIL

    response = client.post("/api/settings/emails", json={
        "contractor_email": "valid@example.com",
        "your_email": "not-an-email",
    })
    assert response.status_code == 400
    assert "CONTRACTOR_EMAIL=valid@example.com" not in isolated_env_file.read_text()
    assert Config.CONTRACTOR_EMAIL == original


# -------------------------------------------------------------- valid input

def test_valid_contractor_email_persists(client, isolated_env_file):
    from mercury.config import Config
    response = client.post("/api/settings/emails", json={
        "contractor_email": "billing@newcontractor.com",
    })
    assert response.status_code == 200
    assert "CONTRACTOR_EMAIL=billing@newcontractor.com" in isolated_env_file.read_text()
    assert Config.CONTRACTOR_EMAIL == "billing@newcontractor.com"


def test_valid_model_name_persists(client, isolated_env_file):
    from mercury.config import Config
    response = client.post("/api/ai/set-model", json={"model": "gemini-3.7-flash"})
    assert response.status_code == 200
    assert "GEMINI_MODEL=gemini-3.7-flash" in isolated_env_file.read_text()
    assert Config.GEMINI_MODEL == "gemini-3.7-flash"


def test_updating_one_setting_does_not_disturb_unrelated_lines(client, isolated_env_file):
    client.post("/api/ai/set-model", json={"model": "gemini-3.7-flash"})
    content = isolated_env_file.read_text()
    assert "EMAIL_PASSWORD=real-app-password" in content
    assert "SENDER_EMAIL=me@example.com" in content


def test_writing_creates_env_if_missing(client, isolated_env_file):
    isolated_env_file.unlink()
    response = client.post("/api/ai/set-model", json={"model": "gemini-3.7-flash"})
    assert response.status_code == 200
    assert isolated_env_file.exists()
    assert "GEMINI_MODEL=gemini-3.7-flash" in isolated_env_file.read_text()


# ------------------------------------------------------ update_env_file()
# Called directly here, with an explicit env_path — no Flask route, no
# monkeypatching, nothing that could touch a real .env regardless of order.

def test_update_env_file_refuses_an_unlisted_key(tmp_path):
    from mercury.config import update_env_file
    target = tmp_path / ".env"
    with pytest.raises(ValueError):
        update_env_file({"SECRET_KEY": "attacker-controlled"}, env_path=target)
    assert not target.exists() or "SECRET_KEY=attacker-controlled" not in target.read_text()


def test_update_env_file_refuses_a_null_byte(tmp_path):
    from mercury.config import update_env_file
    target = tmp_path / ".env"
    with pytest.raises(ValueError):
        update_env_file({"GEMINI_MODEL": "gemini\x00-evil"}, env_path=target)


def test_update_env_file_ignores_data_dir_entirely(tmp_path, monkeypatch):
    """The bug this write path used to have: Config.DATA_DIR.parent was only
    the right answer by accident, and broke under a configured
    MERCURY_DATA_DIR. Point DATA_DIR somewhere unrelated to the target and
    confirm the write is unaffected by it."""
    from mercury.config import Config, update_env_file
    monkeypatch.setattr(Config, "DATA_DIR", tmp_path / "elsewhere" / "data")

    target = tmp_path / ".env"
    update_env_file({"GEMINI_MODEL": "gemini-3.7-flash"}, env_path=target)
    assert "GEMINI_MODEL=gemini-3.7-flash" in target.read_text()


def test_routes_do_not_reference_data_dir_for_the_env_path():
    """Static guard against the regression coming back: if either route ever
    goes back to deriving the .env path from Config.DATA_DIR, this fails
    immediately rather than waiting on a user to notice a setting silently
    not persisting."""
    import inspect
    for route in (api_module.api_set_model, api_module.api_set_emails):
        source = inspect.getsource(route)
        assert "DATA_DIR" not in source, (
            f"{route.__name__} references Config.DATA_DIR for the .env path again")


# --------------------------------------------------------- non-string input

def test_non_string_model_name_is_rejected_not_a_500(client, isolated_env_file):
    response = client.post("/api/ai/set-model", json={"model": 12345})
    assert response.status_code == 400


def test_non_string_email_is_rejected_not_a_500(client, isolated_env_file):
    response = client.post("/api/settings/emails", json={"contractor_email": ["a@b.com"]})
    assert response.status_code == 400
