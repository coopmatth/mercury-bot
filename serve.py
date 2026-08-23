#!/usr/bin/env python3
"""Production entry point.

Runs the app under waitress using the HOST and PORT from .env, so there is
one place to change them — the systemd unit does not repeat them.

    python serve.py

HOST is the address to *bind*, not a hostname:

  127.0.0.1   only this machine. Correct when Tailscale (or any reverse
              proxy) fronts the app — it forwards to localhost, and nothing
              on the LAN can reach the app directly.
  0.0.0.0     every interface, so other devices on the LAN can connect.
"""
from waitress import serve

from mercury import create_app
from mercury.config import Config


def main() -> None:
    app = create_app()
    where = "this machine only" if Config.HOST in ("127.0.0.1", "localhost") else "all interfaces"
    print(f"  Mercury Tracker → http://{Config.HOST}:{Config.PORT}  ({where})")
    print(f"  Data → {Config.DATA_DIR}")
    serve(app, host=Config.HOST, port=Config.PORT, threads=8,
          ident="Mercury Tracker")


if __name__ == "__main__":
    main()
