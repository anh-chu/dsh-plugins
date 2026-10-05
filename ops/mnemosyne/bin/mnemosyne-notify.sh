#!/usr/bin/env bash
# Send one alert to Sil's phone through Home Assistant.
#
#   mnemosyne-notify.sh "message" [title]
#
# Wraps the notify-with-hass skill. The HA URL and token never touch this file or argv:
# they come from 1Password through `op run`, which reads only the references file kept
# next to the skill. Needs OP_SERVICE_ACCOUNT_TOKEN and HASS_NOTIFY_DEVICE from the two
# env files below. A systemd unit has no login shell, so load them explicitly.
#
# A failed notification must never hide the failure it reports. This script therefore
# never exits non-zero for a send problem; it writes the problem to stderr (the journal)
# and to a marker file that the health script checks.
set -uo pipefail

MSG="${1:-mnemosyne needs attention}"
TITLE="${2:-Memory}"
SKILL=/home/sil/.agents/skills/smart-home/notify-with-hass
MARK=/home/sil/.dsh/mnemosyne/notify-failed.flag

set -a
# shellcheck disable=SC1091
[ -f /home/sil/.config/op/service-account.env ] && . /home/sil/.config/op/service-account.env
[ -f /home/sil/.agents/.env ] && . /home/sil/.agents/.env
set +a

# Terse, no em-dashes (house style), and capped: the lock screen shows little.
MSG=$(printf '%s' "$MSG" | tr -d '\r' | sed 's/ — /, /g' | cut -c1-300)

if out=$(/usr/bin/op run --env-file="$SKILL/oprefs.env" -- /usr/bin/bash "$SKILL/scripts/ha_notify.sh" -m "$MSG" -t "$TITLE" 2>&1); then
  echo "notify: $out"
  rm -f "$MARK"
else
  echo "notify FAILED: $out" >&2
  date -u +%FT%TZ > "$MARK"
fi
exit 0
