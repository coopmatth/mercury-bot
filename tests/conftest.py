import os
import tempfile

import pytest

# Point the app at a throwaway data directory before anything imports Config.
_tmp = tempfile.mkdtemp(prefix="mercury-tests-")
os.environ["MERCURY_DATA_DIR"] = _tmp
os.environ["SECRET_KEY"] = "test-key"


@pytest.fixture()
def app():
    from mercury import create_app
    from mercury.config import Config
    from mercury.db import close_db, get_db

    application = create_app()
    yield application

    # Each test starts from an empty database.
    conn = get_db()
    with conn:
        for table in ("jobs", "custom_items", "equipment_scans", "invoices", "sync_devices"):
            conn.execute(f"DELETE FROM {table}")
        conn.execute("UPDATE meta SET value = '0' WHERE key = 'seq_counter'")
    close_db()


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def ctx(app):
    with app.app_context():
        yield
