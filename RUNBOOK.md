# Go-live runbook

For when the code is cloned and `pip install` is done, and you want it running
24/7 and on your phone. [INSTALL.md](INSTALL.md) is the manual — this is the
order to do things in, and how to tell each step worked.

Nothing here is compiled. There is no build step; an update is a `git pull`
and a restart.

---

## 1. Confirm you are on current code

```bash
cd ~/mercury-bot
git branch --show-current      # main
git log --oneline -1
```

On the old `claude/app-redesign-offline-sync-8ye6tn` branch, or behind?
See [INSTALL.md § 9](INSTALL.md#9-updating). `git restore .` never touches
`.env` or `data/` — both are git-ignored.

## 2. Check `.env`

```bash
grep -E '^(HOST|PORT|SECRET_KEY|SENDER_EMAIL|CONTRACTOR_EMAIL|YOUR_EMAIL)=' .env
```

- `HOST=127.0.0.1` — Tailscale forwards to localhost, so nothing on the LAN
  reaches the app directly. Omit the line and it binds `0.0.0.0` instead.
- `SECRET_KEY` — long and random, not the placeholder.
- `EMAIL_PASSWORD` — the 16-character Gmail App Password.

Everything else has a working default; a missing line will not stop it
starting.

## 3. Run it in the foreground once

Before systemd, so errors land in front of you rather than in a journal.

```bash
source .venv/bin/activate
python serve.py
```

```
  Mercury Tracker → http://127.0.0.1:8080  (this machine only)
```

From a second terminal:

```bash
curl -s localhost:8080/healthz
# {"ok":true,"seq":0}

curl -s -X POST localhost:8080/api/quote -H 'Content-Type: application/json' \
     -d '{"items":{"Aerial Drop Footage":780}}'
# {"total":239.5}      <- confirms the aerial tiering is live
```

Open <http://localhost:8080>, log a throwaway job, delete it. `Ctrl+C`.

## 4. Run it 24/7

```bash
mkdir -p ~/.config/systemd/user
cp deploy/mercury.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mercury
loginctl enable-linger $USER       # starts at boot without you logging in
```

```bash
systemctl --user status mercury    # active (running)
curl -s localhost:8080/healthz
```

The unit assumes `~/mercury-bot` and runs `serve.py`, which reads `HOST` and
`PORT` from `.env` — they are not repeated in the unit.

## 5. HTTPS via Tailscale

Required, not optional: phones only run service workers on HTTPS or
localhost, and without one the app will not install or work offline.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Enable **HTTPS Certificates** once at
[login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns), then:

```bash
sudo tailscale serve --bg 8080     # older versions: sudo tailscale serve https:443 / http://127.0.0.1:8080
tailscale serve status             # prints your https://<machine>.<tailnet>.ts.net URL
```

Do **not** open a firewall port — Tailscale forwards to localhost, which is
what `HOST=127.0.0.1` is for.

## 6. Install on the phone

1. Tailscale app on the phone, same account.
2. Open the `https://….ts.net` URL.
3. **Android/Chrome:** ⋮ → *Add to Home screen*. **iPhone/Safari:** Share →
   *Add to Home Screen*.
4. Open it from the home screen once **with signal** so the service worker
   caches every screen.
5. Airplane mode, open it again.

Offline you should get every screen, a live running total while logging a job,
the job listed as **not synced**, and dashboard totals including it. Restore
signal and the queue drains on its own — the job shows up on the PC at
`/jobs`.

---

## Verification

| Check | How | Expect |
|---|---|---|
| Tests | `pip install -r requirements-dev.txt && python -m pytest tests/ -q` | `87 passed` |
| Service up | `systemctl --user status mercury` | `active (running)` |
| Survives reboot | `sudo reboot` then `curl -s localhost:8080/healthz` | `{"ok":true,...}` |
| Pay math | `POST /api/quote`, 780 ft aerial | `239.5` |
| HTTPS | open the `ts.net` URL | padlock, no warning |
| Installs | *Add to Home screen* | opens fullscreen |
| Offline | airplane mode, log a job | saves, *not synced* |
| Sync | restore signal | queue drains, job on the PC |
| Email | Reports → *Email me* | arrives with the `.xlsx` |
| AI model | Settings → AI model → *Check available models* | lists models, marks yours |

Snags and fixes: [INSTALL.md § Troubleshooting](INSTALL.md#troubleshooting).

---

## Afterwards

- **Update:** `git pull && systemctl --user restart mercury`. The restart is
  required — the service worker's cache version is computed once per process,
  so skipping it leaves phones on cached code.
- **Back up:** Settings → *Download a backup*, safe while running. Keep a copy
  off the machine.
- **Poke at it safely:** `python demo.py` runs a sandbox on its own database
  with a fictional identity and email disabled.
