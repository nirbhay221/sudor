#!/usr/bin/env bash
# Install the uploaded Sudor bundle on the host, through SSM. Run by a person, after deploy/bundle.sh.
#
# Backs up the running build and its data, installs the new one, restarts, and puts the old
# build back if the new one is not healthy within a minute (a fixed twelve seconds once rolled back a good
# build whose feeds were slow to answer at boot). Prints DEPLOYED or FAILED_ROLLING_BACK.
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"

AWS="${AWS:-aws}"
REGION="${REGION:-us-east-1}"
INSTANCE="${INSTANCE:?set INSTANCE to the EC2 instance id}"
BUCKET="${BUCKET:?set BUCKET to the deploy bucket}"

ID="$("$AWS" ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript --timeout-seconds 600 --parameters "commands=[
    \"set -e\",
    \"rm -rf /opt/sudor.bak && cp -a /opt/sudor /opt/sudor.bak\",
    \"cp -a /var/lib/sudor /var/lib/sudor.bak-\$(date +%s)\",
    \"aws s3 cp s3://${BUCKET}/sudor/app.tar.gz /tmp/sudor.tar.gz --quiet\",
    \"tar -xzf /tmp/sudor.tar.gz -C /opt/sudor\",
    \"cd /opt/sudor && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2\",
    \"chown -R sudor:sudor /opt/sudor\",
    \"install -d -m 0755 /usr/local/libexec\",
    \"install -m 0755 /opt/sudor/deploy/sudor-secrets.sh /usr/local/libexec/sudor-secrets\",
    \"install -d /etc/systemd/system/sudor.service.d\",
    \"install -m 0644 /opt/sudor/deploy/sudor-hardening.conf /etc/systemd/system/sudor.service.d/10-hardening.conf\",
    \"systemctl daemon-reload\",
    \"systemctl restart sudor\",
    \"for i in 1 2 3 4 5 6 7 8 9 10 11 12; do sleep 5; curl -sf -m 4 http://127.0.0.1:8081/health >/dev/null && break; done\",
    \"if systemctl is-active --quiet sudor && curl -sf -m 5 http://127.0.0.1:8081/health >/dev/null; then echo DEPLOYED; else echo FAILED_ROLLING_BACK; journalctl -u sudor -n 20 --no-pager; rm -f /etc/systemd/system/sudor.service.d/10-hardening.conf; rm -rf /opt/sudor && mv /opt/sudor.bak /opt/sudor; systemctl daemon-reload; systemctl restart sudor; fi\"
  ]" --query Command.CommandId --output text)"

echo "started $ID, waiting for the host"
for _ in $(seq 1 18); do
  sleep 10
  STATUS="$("$AWS" ssm get-command-invocation --region "$REGION" --command-id "$ID" --instance-id "$INSTANCE" --query Status --output text)"
  [ "$STATUS" != "InProgress" ] && [ "$STATUS" != "Pending" ] && break
done
"$AWS" ssm get-command-invocation --region "$REGION" --command-id "$ID" --instance-id "$INSTANCE" \
  --query "[Status,StandardOutputContent,StandardErrorContent]" --output text | tail -25
