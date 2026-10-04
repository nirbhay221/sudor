#!/usr/bin/env bash
# Fetch this service's secrets from SSM Parameter Store into a tmpfs file.
#
# Install on the host as /usr/local/libexec/sudor-secrets (mode 0755). Runs as root
# immediately before the service starts, from ExecStartPre in sudor.service. The file
# it writes lives on tmpfs, so it is gone at reboot, readable only by the service user,
# and never part of an image, a unit file or a repository.
#
# A parameter that does not exist is simply left out, which is deliberate: the service
# then decides what that means. With SUDOR_REQUIRE_ENCRYPTION=on, a missing data key
# stops it from starting, which is the correct failure, rather than serving
# medications and locations out of a plaintext file because an environment variable
# was forgotten.
set -euo pipefail
umask 077
# The directory and owner can be overridden so the script can be tested without root and without
# a sudor user. On the host neither variable is set and the defaults apply.
dir="${SUDOR_SECRETS_DIR:-/run/sudor}"
owner="${SUDOR_SECRETS_OWNER:-sudor}"
if [ "$owner" = "none" ]; then
  install -d -m 0750 "$dir"
else
  install -d -m 0750 -o "$owner" -g "$owner" "$dir"
fi
out="$dir/env"
rm -f "$out"
: >"$out"

get() {
  aws ssm get-parameter --region us-east-1 --name "$1" --with-decryption \
    --query Parameter.Value --output text 2>/dev/null || true
}

key="$(get /sudor/data-key)"
[ -n "$key" ] && printf 'SUDOR_DATA_KEY=%s\n' "$key" >>"$out"

# Keys being rotated out, comma separated. Data sealed under them still opens and is
# re-sealed under the current key on the next load.
prev="$(get /sudor/data-key-previous)"
[ -n "$prev" ] && printf 'SUDOR_DATA_KEY_PREVIOUS=%s\n' "$prev" >>"$out"

# The origin secret is only handed to the service when it has been armed, and arming
# is a separate, explicit parameter. The secret can exist for weeks before anything
# sends it: if the service enforced it the moment it existed, deploying before the
# API Gateway integration was updated to send the header would answer every public
# request with a 403. Order: update the gateway, confirm it works, then arm.
if [ "$(get /sudor/origin-enforce)" = "on" ]; then
  sec="$(get /sudor/origin-secret)"
  [ -n "$sec" ] && printf 'SUDOR_ORIGIN_SECRET=%s\n' "$sec" >>"$out"
fi

# The address email is sent from, once it has been verified in Amazon SES. Not a secret, but kept here so
# switching email on is one parameter and a restart, with no edit to the unit file. Absent means no email
# is sent, and every answer says so.
from="$(get /sudor/email-from)"
[ -n "$from" ] && printf 'SUDOR_EMAIL_FROM=%s\n' "$from" >>"$out"

[ "$owner" = "none" ] || chown "$owner:$owner" "$out"
chmod 0400 "$out"
