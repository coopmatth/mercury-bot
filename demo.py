#!/usr/bin/env python3
"""Launch Mercury Tracker in its sandbox.

    python demo.py

Demo mode is completely walled off from real use:

  * its own database at data/demo/mercury-demo.db — your real data is untouched
  * a fictional technician and contractor, so no personal details reach an invoice
  * email is written to data/demo/outbox as .eml files, never sent
  * two weeks of realistic sample work, seeded on first run

Open the printed address on your phone and use "Add to Home Screen" to install
it, then turn on airplane mode to try the offline behaviour.
"""
import os
import socket

os.environ["MERCURY_DEMO"] = "1"
os.environ.setdefault("SECRET_KEY", "demo-secret-not-for-real-use")


def lan_address() -> str:
    """Best guess at the address a phone on the same network can reach."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))          # no packets are actually sent
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def main() -> None:
    from mercury import create_app
    from mercury.config import Config

    app = create_app()
    port = Config.PORT

    print()
    print("  Mercury Tracker — DEMO SANDBOX")
    print("  " + "-" * 44)
    print(f"  On this computer   http://localhost:{port}")
    print(f"  On your phone      http://{lan_address()}:{port}")
    print()
    print(f"  Database           {Config.DB_PATH}")
    print(f"  Captured email     {Config.OUTBOX_DIR}")
    print("  Email sending      disabled")
    print()
    print("  Add to Home Screen on the phone, then switch on airplane mode")
    print("  to try logging jobs with no signal.")
    print()

    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
