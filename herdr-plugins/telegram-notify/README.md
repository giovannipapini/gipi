# Telegram Notify (Herdr plugin)

Sends a Telegram message when a Herdr agent reaches a configured state (default
`blocked`), **unless you are already looking at that pane**.

Herdr plugin event hooks are not attention-aware: every `pane.agent_status_changed`
reaches the hook no matter which pane has focus. This plugin adds the gate itself,
plus a cooldown so a prompt that re-blocks in a loop cannot spam.

## Why not the upstream example

`ogulcancelik/herdr-plugin-examples/agent-telegram-notify` notifies on every
`blocked`/`done` transition and never suppresses for the focused pane, so it buzzes
while you are sitting in front of the prompt.

## Setup

```bash
herdr plugin link /home/pi/dev/github/gipi/herdr-plugins/telegram-notify
herdr plugin config-dir gipi.telegram-notify
```

Put credentials in `<config dir>/.env` (owner-only; the plugin tightens the mode to
`600` if anything can read it):

```sh
TELEGRAM_BOT_TOKEN=123456:abc...
TELEGRAM_CHAT_ID=123456789
```

Verify:

```bash
herdr plugin action invoke check   --plugin gipi.telegram-notify   # masked config + perms
herdr plugin action invoke preview --plugin gipi.telegram-notify   # print the message, send nothing
herdr plugin action invoke test    --plugin gipi.telegram-notify   # one real message
herdr plugin log list --plugin gipi.telegram-notify
```

## Message format

```text
⚠️ pi is waiting for you
▸ herdr · gipi · tab 1 · w6:p8
pi-agent (telegram blocked notify) · ~/dev/github/gipi
```

Line 1 is the state in plain words (`is waiting for you` / `finished` / `went idle`), prefixed with
the agent label exactly as Herdr reports it — lowercase `pi`, `claude`, `codex`, whatever occupies
the pane, never a hardcoded name. Line 2 is the Herdr location (workspace · tab · pane id), line 3
is the pane's terminal title and cwd with `$HOME` collapsed to `~`. A shell-style `user@host:/path`
title that only repeats the cwd is dropped.

`herdr plugin log list` shows `exit_code` and `status` — read **stderr**, not the
status: every skip path exits 0, so `succeeded` only means the hook ran.

## Settings

| Env var                       | Default   | Meaning                                             |
| ----------------------------- | --------- | --------------------------------------------------- |
| `TELEGRAM_STATES`             | `blocked` | Comma list of states that notify (`blocked,done`)   |
| `TELEGRAM_QUIET_WHEN_FOCUSED` | `1`       | Skip when the changed pane is the focused pane      |
| `TELEGRAM_COOLDOWN_SECONDS`   | `120`     | Per-pane minimum gap between messages; `0` disables |

## Credentials

Read from `$HERDR_PLUGIN_CONFIG_DIR/.env` (Herdr-managed, outside this repo) with a
development fallback to `.env` beside the scripts, which is gitignored. Errors are
passed through `redact()` — the Telegram URL embeds the token, and `fetch` quotes
URLs in its errors, so raw messages are never printed.
