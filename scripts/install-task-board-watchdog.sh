#!/usr/bin/env bash
# Install (or remove) the task-board watchdog as a systemd user timer.
#
# The watchdog is one probe per run, outside dsh: when the Host's event loop is
# blocked (three sessions on four cores, a stuck tool job), it is the only
# process that can still see "the health route stopped answering" and restart
# dsh as the last resort. It never touches a host that was not seen healthy, a
# closed port or a missing route; only a sustained hang restarts (see
# src/core/watchdog.ts).
#
# Usage:
#   scripts/install-task-board-watchdog.sh            # install + enable
#   scripts/install-task-board-watchdog.sh --dry-run  # print the units only
#   scripts/install-task-board-watchdog.sh --uninstall
#
# Options:
#   --port <n>      dsh loopback port (default 3080)
#   --home <dir>    DSH home (default $DSH_HOME or ~/.dsh)
#   --node <path>   node interpreter (default: readlink -f "$(command -v node)")
#   --no-enable     write the units, do not enable/start the timer
set -uo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="dsh-task-board-watchdog.service"
TIMER="dsh-task-board-watchdog.timer"
SCRIPT_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# The timer must point at the *deployed* plugin, not at the worktree this
# installer happens to sit in: a card's worktree is removed when the card is
# archived. The profile link names the checkout dsh actually loads.
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
PROFILE_LINK="$PROFILE_DIR/node_modules/dsh-next-task-board"
if [ -n "${DSH_WATCHDOG_ROOT:-}" ]; then
  ROOT="$DSH_WATCHDOG_ROOT"
elif [ -e "$PROFILE_LINK" ]; then
  ROOT="$(readlink -f "$PROFILE_LINK")"
else
  ROOT="$SCRIPT_ROOT"
fi
PORT="${DSH_LOOPBACK_PORT:-3080}"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
NODE_BIN="${NODE_BIN:-}"
MODE="install"
ENABLE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) MODE="uninstall" ;;
    --dry-run) MODE="dry-run" ;;
    --no-enable) ENABLE=0 ;;
    --port) shift; PORT="${1:?--port needs a value}" ;;
    --home) shift; HOME_DIR="${1:?--home needs a value}" ;;
    --node) shift; NODE_BIN="${1:?--node needs a value}" ;;
    --root) shift; ROOT="${1:?--root needs a value}" ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  for candidate in "$HOME/.nvm/versions/node"/*/bin/node /usr/bin/node /usr/local/bin/node; do
    [ -x "$candidate" ] && NODE_BIN="$candidate" && break
  done
fi

if [ "$MODE" = "uninstall" ]; then
  systemctl --user disable --now "$TIMER" 2>/dev/null || true
  rm -f "$UNIT_DIR/$TIMER" "$UNIT_DIR/$SERVICE"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "removed $UNIT_DIR/$TIMER and $UNIT_DIR/$SERVICE"
  exit 0
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "no node interpreter found; pass --node <path>" >&2
  exit 1
fi
WATCHDOG="$ROOT/lib/watchdog.js"
# A deployed checkout that does not carry the watchdog build yet (the fix is
# merged into main, but `pnpm build` has not run there) must not make the timer
# fail every 30 s: the unit is guarded by ExecCondition and starts working as
# soon as the file exists.
if [ ! -f "$WATCHDOG" ]; then
  echo "note: $WATCHDOG does not exist yet — installing a passive unit (ExecCondition) that starts probing once the checkout carries the build" >&2
fi

read -r -d '' SERVICE_BODY <<EOF
[Unit]
Description=DSH task-board watchdog (one health probe; restarts dsh only on a sustained hang)
Documentation=file://$ROOT/AGENTS.md

[Service]
Type=oneshot
# Absolute paths only: the systemd user manager does not read the login shell.
# The restart command defaults to ~/.local/bin/dsh-stop --restart, and the
# watchdog runs outside dsh's process tree, so it survives the restart it starts.
# Passive until the deployed checkout actually carries the watchdog build
# (a merge into main followed by pnpm build), then it probes on every tick.
ExecCondition=/usr/bin/test -f $WATCHDOG
ExecStart=$NODE_BIN $WATCHDOG --home $HOME_DIR --port $PORT
# A probe must never keep the unit alive; the timer starts the next one.
TimeoutStartSec=30
EOF

read -r -d '' TIMER_BODY <<EOF
[Unit]
Description=Probe the DSH task-board host every 30 s

[Timer]
OnBootSec=60s
OnUnitActiveSec=30s
AccuracySec=5s
Unit=$SERVICE

[Install]
WantedBy=timers.target
EOF

if [ "$MODE" = "dry-run" ]; then
  echo "--- $UNIT_DIR/$SERVICE"
  printf '%s\n' "$SERVICE_BODY"
  echo "--- $UNIT_DIR/$TIMER"
  printf '%s\n' "$TIMER_BODY"
  exit 0
fi

mkdir -p "$UNIT_DIR"
printf '%s\n' "$SERVICE_BODY" > "$UNIT_DIR/$SERVICE"
printf '%s\n' "$TIMER_BODY" > "$UNIT_DIR/$TIMER"
systemctl --user daemon-reload

# One manual probe up front: an uninstalled/not-yet-working node path or a
# missing log directory shows here instead of on the first timer tick.
if [ -f "$WATCHDOG" ]; then
  echo "--- probe (dry-run, no restart):"
  "$NODE_BIN" "$WATCHDOG" --home "$HOME_DIR" --port "$PORT" --dry-run --verbose || true
fi

if [ "$ENABLE" = "1" ]; then
  systemctl --user enable --now "$TIMER"
  echo "--- timer status:"
  systemctl --user --no-pager --lines=5 status "$TIMER" || true
else
  echo "units written; enable with: systemctl --user enable --now $TIMER"
fi
