"""Mercury Tracker — offline-first field job tracking, pay and invoicing."""
from __future__ import annotations

from flask import Flask

from .config import Config

__version__ = "2.0.0"


def create_app(config: type[Config] = Config) -> Flask:
    app = Flask(
        __name__,
        static_folder="../static",
        template_folder="../templates",
        static_url_path="/static",
    )
    app.config.from_object(config)
    app.secret_key = config.SECRET_KEY
    app.config["JSON_SORT_KEYS"] = False
    app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024  # 32 MB of label photos

    config.ensure_dirs()

    from .db import close_db, init_db
    with app.app_context():
        init_db()
        if config.DEMO:
            from .demo import seed_if_empty
            seed_if_empty()
    app.teardown_appcontext(close_db)

    from .blueprints.api import bp as api_bp
    from .blueprints.web import bp as web_bp
    app.register_blueprint(web_bp)
    app.register_blueprint(api_bp)

    from .filters import register_filters
    register_filters(app)

    return app
