#!/usr/bin/env python3
"""Development / single-technician entry point.

For a machine that stays on and serves the phone over the LAN or a tunnel,
run it behind a real server instead:

    waitress-serve --host 0.0.0.0 --port 8080 --call mercury:create_app
"""
from mercury import create_app
from mercury.config import Config

app = create_app()

if __name__ == "__main__":
    print(f"  Mercury Tracker  →  http://{Config.HOST}:{Config.PORT}")
    print(f"  Data directory   →  {Config.DATA_DIR}")
    app.run(host=Config.HOST, port=Config.PORT, debug=Config.DEBUG, threaded=True)
