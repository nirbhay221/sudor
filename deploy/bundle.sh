#!/usr/bin/env bash
# Build what the server needs and nothing else, then hand it to S3.
#
# The repository is private, so the instance cannot clone it. It pulls this
# tarball instead, which carries package-lock.json so the host installs the
# locked versions rather than resolving fresh ones, and the systemd unit so the
# service definition lives with the code it starts.
set -euo pipefail

AWS="${AWS:-aws}"
BUCKET="${1:?usage: bundle.sh <s3-bucket> [key]}"
KEY="${2:-sudor/app.tar.gz}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"
npm run build

# Written inside the repository rather than /tmp, because the AWS CLI on Windows
# is a native program and cannot open a Unix style temp path.
mkdir -p .deploy
tar -czf .deploy/app.tar.gz dist web ui assets skills package.json package-lock.json deploy/sudor.service deploy/sudor-secrets.sh deploy/sudor-hardening.conf

"$AWS" s3 cp .deploy/app.tar.gz "s3://${BUCKET}/${KEY}"
echo "uploaded s3://${BUCKET}/${KEY}"
