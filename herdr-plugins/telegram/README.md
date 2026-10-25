# Telegram (Herdr plugin)

Sends a Telegram message when a Herdr agent blocks **or finishes** (default
`blocked,done`), **unless you are already looking at that pane** — with a roster of the
other agents below it, most urgent first.

Herdr plugin event hooks are not attention-aware: every `pane.agent_status_changed`
reaches the hook no matter which pane has focus. This plugin adds the gate itself,
plus a cooldown so a prompt that re-blocks in a loop cannot spam.

## Why not the upstream example

`ogulcancelik/herdr-plugin-examples/agent-telegram-notify` notifies on every
`blocked`/`done` transition and never suppresses for the focused pane, so it buzzes
while you are sitting in front of the prompt.

## Setup

```bash
herdr plugin link /home/pi/dev/github/gipi/herdr-plugins/telegram
herdr plugin config-dir gipi.telegram
```

Put credentials in `<config dir>/.env` (owner-only; the plugin tightens the mode to
`600` if anything can read it):

```sh
TELEGRAM_BOT_TOKEN=123456:abc...
TELEGRAM_CHAT_ID=123456789
```

Verify:

```bash
herdr plugin action invoke check   --plugin gipi.telegram   # masked config, perms, turn-end mapping
herdr plugin action invoke preview --plugin gipi.telegram   # print the message, send nothing
herdr plugin action invoke preview-done --plugin gipi.telegram  # same, for `done`
herdr plugin action invoke test    --plugin gipi.telegram   # one real message
herdr plugin log list --plugin gipi.telegram
```

## Message format

```text
✅ pi finished · 1 waiting
▸ herdr · pi · tab 3 · w8:pG
π · gipi · 20261025T0357 · ~/dev/github/gipi
── other agents · 3 ──
⚠️ claude · gipi · tab 4 · w8:pT
⚙️ pi · pi · tab 1
💤 pi · dotfiles · tab 2
```

Line 1 is the state in plain words (`is waiting for you` / `finished` / `went idle`), prefixed with
the agent label exactly as Herdr reports it — lowercase `pi`, `claude`, `codex`, whatever occupies
the pane, never a hardcoded name. When another agent is blocked it says so here, e.g. `· 1 waiting`.
Line 2 is the Herdr location (workspace · tab · pane id), line 3 is the pane's terminal title and
cwd with `$HOME` collapsed to `~`. A shell-style `user@host:/path` title that only repeats the cwd
is dropped.

Below that, the other agents in the session, one line each: state icon, agent, project (the cwd's
last segment), tab, plus the pane id when its tab holds more than one pane. Ordered by what you
have to act on, not by layout:

| Order | Icon | State     | Why it sits there                     |
| ----- | ---- | --------- | ------------------------------------- |
| 1     | ⚠️   | `blocked` | Stuck until you answer                |
| 2     | ✅   | `done`    | Finished, output unread               |
| 3     | ⚙️   | `working` | Moving on its own, nothing to do      |
| 4     | 💤   | `idle`    | Nothing happening                     |
| 5     | ·    | _other_   | Unknown state — last, and undecorated |

Panes with no agent (a plain shell) are not listed. The pane the message is about is described in
lines 1–3 and is not repeated in the roster.

### Why it looks like this

A phone shows only the first line or two until you open the message, so the format is built
backwards from that constraint: **the first line has to be worth the interruption on its own**.
- Material 3 puts the budget at <29 characters for a title, <40 for a collapsed body, and asks for
  the most important information first, because people skim in an F shape.
- Airship's guidance is that the actionable part must land inside the first 40 characters; Android
  truncates the lock screen around 50.
- _Alert payload design_ (Big Iron) asks for a title that states the symptom, a body of three or four
  lines of evidence, and no more — so the roster is capped and the remainder is named rather than
  dropped.
- Herdr's own `herdr notification show` takes a `TITLE` plus a `--body`, the same shape: symptom on
  top, evidence underneath.

Hence `✅ pi finished · 1 waiting` — 27 characters, the event _and_ the reason to act before you
ever see the list. Icons are limited to one per line and never replace a word.

`herdr plugin log list` shows `exit_code` and `status` — read **stderr**, not the
status: every skip path exits 0, so `succeeded` only means the hook ran. Every skip says
why, including a status the settings do not notify on (`skip: idle is not a notify state
(previous working)`). If the session snapshot cannot be read the roster is skipped and
stderr says `roster unavailable`, so a message without a list is never mistaken for a
session with no other agents.

## Settings

| Env var                       | Default        | Meaning                                        |
| ----------------------------- | -------------- | ---------------------------------------------- |
| `TELEGRAM_STATES`             | `blocked,done` | Comma list of states that notify               |
| `TELEGRAM_QUIET_WHEN_FOCUSED` | `1`            | Skip when the changed pane is the focused pane |
| `TELEGRAM_COOLDOWN_SECONDS`   | `120`          | Per-pane, per-state minimum gap; `0` disables  |
| `TELEGRAM_ROSTER_LIMIT`       | `5`            | Roster lines per message; `0` hides the block  |

The cooldown is keyed by pane **and** state: an agent that finishes out of focus
and asks for input again 10 seconds later still sends both messages.

### `done` for agents that never report it

Herdr's `done` is "finished this turn", but not every integration reports it: **pi**
reports the same moment as `working` → `idle`. So an `idle` that follows `working`
notifies as `done` (`✅ pi finished`), while an `idle` that was already idle — a session
start, a reload — says nothing. The plugin keeps each pane's last status in its state
file to make that distinction; listing `idle` in `TELEGRAM_STATES` opts back in to raw
idle transitions (`💤 … went idle`).

## Tests

```bash
pnpm test          # node --test: the rules in hook.mjs, no Herdr or network needed
```

The gating and wording live in `hook.mjs` as pure functions (state, clock and pane
snapshot arrive as arguments), so `hook.test.mjs` covers them directly: default and
parsed states, turn-end mapping (`done`, and `working` → `idle`), focus resolution,
per-status cooldown, the message body, and the roster (urgency order, trigger-pane
exclusion, shell panes, the cap and its `+N more`).
`notify.mjs` is only the wiring to Herdr, Telegram and the state file.

## Credentials

Read from `$HERDR_PLUGIN_CONFIG_DIR/.env` (Herdr-managed, outside this repo) with a
development fallback to `.env` beside the scripts, which is gitignored. Errors are
passed through `redact()` — the Telegram URL embeds the token, and `fetch` quotes
URLs in its errors, so raw messages are never printed.
