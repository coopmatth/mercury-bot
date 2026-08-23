# Installing Mercury Tracker on Linux

Start to finish: about ten minutes. Everything runs on your own machine — no
accounts, no hosting bill, nothing leaves the network except the email you
send yourself.

---

## 1. Prerequisites

Python 3.10 or newer, plus git. Check what you have:

```bash
python3 --version
git --version
```

Install if either is missing:

```bash
# Debian / Ubuntu / Linux Mint / Pop!_OS
sudo apt update && sudo apt install -y python3 python3-venv python3-pip git

# Fedora
sudo dnf install -y python3 python3-pip git

# Arch
sudo pacman -S --needed python python-pip git
```

---

## 2. Get the code out of the private repo

You sign in to GitHub with Google, which means **you have no GitHub password
to give git**. Git over HTTPS will reject your Google password. Use the
GitHub CLI — it opens a browser and your Google sign-in works normally.

```bash
# Debian / Ubuntu
sudo apt install -y gh
# Fedora
sudo dnf install -y gh
# Arch
sudo pacman -S github-cli
```

If your distro has no `gh` package, grab the binary from
<https://github.com/cli/cli/releases> — no sign-in needed to download it.

Then authenticate and clone:

```bash
gh auth login
#   ? What account do you want to log into?   GitHub.com
#   ? What is your preferred protocol?        HTTPS
#   ? Authenticate Git with your credentials? Yes
#   ? How would you like to authenticate?     Login with a web browser
#
# Copy the one-time code it shows, press Enter, sign in with Google,
# paste the code. Done — `gh` also configures git to reuse this login.

cd ~
gh repo clone coopmatth/mercury-bot
cd mercury-bot
git checkout claude/app-redesign-offline-sync-8ye6tn
```

<details>
<summary>Prefer not to install <code>gh</code>? Use a Personal Access Token</summary>

Create one at **GitHub → Settings → Developer settings → Personal access
tokens → Fine-grained tokens**, give it *Contents: Read-only* on
`coopmatth/mercury-bot`, then:

```bash
git clone https://github.com/coopmatth/mercury-bot.git
# Username: coopmatth
# Password: paste the token (not your Google password)

cd mercury-bot
git checkout claude/app-redesign-offline-sync-8ye6tn
git config credential.helper 'cache --timeout=86400'   # stop it asking every time
```
</details>

---

## 3. Install it

A virtual environment keeps these packages out of your system Python:

```bash
cd ~/mercury-bot
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

`source .venv/bin/activate` is needed in any new terminal before running the
app by hand. The systemd service in step 7 handles it for you.

Confirm the install is sound — this runs the full test suite offline:

```bash
pip install -r requirements-dev.txt
python -m pytest tests/ -q
```

You should see `78 passed`. It needs no network and no browser.

---

## 4. Configure it

```bash
cp .env.example .env
nano .env
```

Fill in at minimum:

| Setting | What to put |
|---|---|
| `SECRET_KEY` | Any long random string — `python3 -c "import secrets; print(secrets.token_hex(32))"` |
| `TECH_*` | Your name, address, phone, email — these print on the invoice |
| `BILL_TO_*` | The contractor's details |
| `SENDER_EMAIL` | The Gmail address the reports send from |
| `EMAIL_PASSWORD` | A Gmail **App Password** (see below) |
| `CONTRACTOR_EMAIL` | Where the GC's weekly sheet goes |
| `YOUR_EMAIL` | Where your pay backup goes |

### Gmail App Password

Your normal Google password will not work for SMTP. You need a 16-character
App Password, and Google only offers them once 2-Step Verification is on:

1. <https://myaccount.google.com/signinoptions/twosv> → turn on 2-Step Verification
2. <https://myaccount.google.com/apppasswords> → create one named "Mercury"
3. Paste the 16 characters into `EMAIL_PASSWORD` (spaces are fine)

> **Rotate the old one.** The app password that was in the old `config.ini`
> was committed in the backup zip, so treat it as public — delete it on that
> same App Passwords page and issue a fresh one.

Leave `GEMINI_API_KEY` blank unless you want AI label reading; the scanner
falls back to on-device OCR, which needs no key and no signal.

---

## 5. Run it

```bash
source .venv/bin/activate
python run.py
```

Open <http://localhost:8080>. Log a job, generate an invoice, email yourself
the pay sheet.

To stop it, press `Ctrl+C`.

> Want to poke around without touching real data first? `python demo.py`
> starts a sandbox with its own database, a fictional identity, sample work,
> and email written to disk instead of sent.

---

## 6. Get it on your phone

This is the part that matters — it's a field app.

### Let the phone reach the machine

Find the machine's LAN address:

```bash
hostname -I | awk '{print $1}'     # e.g. 192.168.1.42
```

Open the port if a firewall is running:

```bash
# Ubuntu / Debian (ufw)
sudo ufw allow 8080/tcp

# Fedora (firewalld)
sudo firewall-cmd --add-port=8080/tcp --permanent && sudo firewall-cmd --reload
```

Now `http://192.168.1.42:8080` loads on the phone, on the same Wi-Fi.

### ⚠ Offline mode needs HTTPS

Phones only allow service workers — the thing that makes the app work with no
signal — on **HTTPS or localhost**. A plain `http://192.168.1.42:8080` address
will load and let you browse, but it will *not* install as an app and it will
*not* work offline. This trips everyone up, so pick one of these:

**Tailscale (recommended).** Free, private, gives you a real HTTPS
certificate, and it also lets the phone reach the app from the field rather
than only from your house:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale cert "$(tailscale status --json | grep -oP '"DNSName":"\K[^"]+' | head -1 | sed 's/\.$//')"
sudo tailscale serve --bg 8080
tailscale serve status        # prints your https://…ts.net address
```

Install Tailscale on the phone, sign in to the same account, and open that
`https://…ts.net` address. Enable **HTTPS Certificates** once in the
[admin console](https://login.tailscale.com/admin/dns) if it asks.

**Quick local test instead.** If you only want to try offline mode on an
Android phone on your own Wi-Fi, tell Chrome to trust the address: open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
`http://192.168.1.42:8080`, and relaunch. Testing only — don't leave it on.

### Install it

Open the HTTPS address on the phone, then:

* **Android / Chrome** — menu ⋮ → *Add to Home screen* → *Install*
* **iPhone / Safari** — Share → *Add to Home Screen*

It opens fullscreen with no browser chrome. Now switch on airplane mode and
log a job: it saves, prices, and lists offline, tagged *not synced*, and the
queue drains by itself when you get signal back.

---

## 7. Keep it running

So it starts with the machine instead of needing a terminal:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/mercury.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mercury
loginctl enable-linger $USER      # keeps running when you're logged out
```

Check and control it:

```bash
systemctl --user status mercury
systemctl --user restart mercury
journalctl --user -u mercury -f    # live log
```

The unit assumes you cloned to `~/mercury-bot`. If you put it elsewhere, edit
`WorkingDirectory` and `ExecStart` in `~/.config/systemd/user/mercury.service`.

---

## 8. Back it up

All your data is one SQLite file. In the app: **Settings → Download a
backup** — safe to do while it's running. Or on a schedule:

```bash
# every night at 11pm, keeping the last 30
crontab -e
0 23 * * * cd ~/mercury-bot && .venv/bin/python -c "from mercury.db import backup_to; from pathlib import Path; from datetime import date; backup_to(Path.home()/f'mercury-backups/{date.today()}.db')" && find ~/mercury-backups -name '*.db' -mtime +30 -delete
```

Keep a copy somewhere other than this machine.

---

## 9. Updating

```bash
cd ~/mercury-bot
git pull
source .venv/bin/activate
pip install -r requirements.txt
systemctl --user restart mercury      # if you set up the service
```

Your database is untouched by updates — it lives in `data/`, which git
ignores.

---

## Troubleshooting

**`ModuleNotFoundError: No module named 'flask'`**
The virtual environment isn't active. `source .venv/bin/activate` first, or
use the full path: `~/mercury-bot/.venv/bin/python run.py`.

**`Address already in use`**
Something already holds port 8080. Use another: `PORT=8090 python run.py`.

**Phone can't load the address**
Both devices on the same Wi-Fi? Firewall open (step 6)? Some routers have
"AP isolation" or a guest network that blocks device-to-device traffic — put
the phone on the main network.

**It loads on the phone but won't install, or breaks offline**
You're on `http://`. See the HTTPS section in step 6.

**Email fails with "SMTP rejected the login"**
That's a normal Google password or an expired App Password. Make a new App
Password (step 4). 2-Step Verification has to be on first.

**The scanner says the offline reader is still downloading**
The OCR engine is ~10 MB and loads in the background on first visit. Open the
Scanner page once with signal and give it a minute; after that it's cached
and works offline.

**Numbers on the phone don't match the machine**
The phone keeps its own copy and syncs. Check the pill in the top-right — if
it shows queued items, tap it to sync. **Settings → Reset local data** on the
phone forces a fresh pull from the server.
