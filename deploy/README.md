# Deploying Sudor

Sudor shares one small AWS instance with Orbita. Two add-ons, one box, because
each is a single Node process holding a little weather in memory, and a second
instance would double the bill to run something the first one is barely using.

Orbita holds port 80 on that host. Sudor runs on 8081, and an API Gateway in
front of it provides the public HTTPS address.

```sh
# 1. build and upload the bundle
AWS="/c/Program Files/Amazon/AWSCLIV2/aws.exe" ./deploy/bundle.sh <bucket> sudor/app.tar.gz

# 2. install or update it on the host, through SSM, no SSH and no keys
aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
  --parameters 'commands=[
    "aws s3 cp s3://<bucket>/sudor/app.tar.gz /tmp/sudor.tar.gz",
    "tar -xzf /tmp/sudor.tar.gz -C /opt/sudor",
    "cd /opt/sudor && npm ci --omit=dev",
    "chown -R sudor:sudor /opt/sudor",
    "install -d -m 0755 /usr/local/libexec",
    "install -m 0755 /opt/sudor/deploy/sudor-secrets.sh /usr/local/libexec/sudor-secrets",
    "install -m 644 /opt/sudor/deploy/sudor.service /etc/systemd/system/sudor.service",
    "systemctl daemon-reload", "systemctl restart sudor"]'
```

The unit now refuses to start without a data key (`SUDOR_REQUIRE_ENCRYPTION=on`), so
**create the key before running step 2**, and back it up somewhere that is not this
account, because it is the only thing that opens the data and there is no recovery:

```sh
aws ssm put-parameter --region us-east-1 --name /sudor/data-key --type SecureString \
  --value "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
```

On start the existing plaintext people file is read and immediately re-sealed. Account
tokens are persisted too, hashed and sealed, so a deploy no longer signs every linked
account out.

**Arm the origin secret last, and never first.** The secret can exist for weeks before
anything sends it, and the fetcher hands it to the service only when
`/sudor/origin-enforce` is `on`. Enforcing before the API Gateway integration sends
`x-sudor-origin` answers every public request with a 403, so: update the gateway,
confirm the public address still works, and only then set
`/sudor/origin-enforce` to `on` and restart.

**Trust one proxy hop.** The unit sets `SUDOR_TRUST_PROXY=1`, so the per-address limits
see the visitor the gateway saw instead of the gateway itself. It must stay `0` if the
process is ever reachable directly, because `X-Forwarded-For` is then whatever the
caller says it is, and it is the origin secret that makes one hop safe.

## What it costs

Nothing beyond the instance Orbita already pays for, plus pennies for the
gateway. The bundle sits in the same S3 bucket under a `sudor/` prefix.

## Choices worth knowing

**Its own service user and its own state directory.** `sudor` cannot read
Orbita's files and Orbita cannot read `/var/lib/sudor`, which holds people's
medications and conditions. The unit also runs with a read-only system, no home
directory access and no new privileges.

**No secrets on the box.** It reads its bundle from S3 and, when family email is
switched on, sends through SES using the instance role. The data key and the origin
secret are SSM SecureStrings under `/sudor/`, which the role can read and nothing
else in the parameter store; they are fetched at service start into a tmpfs file, so
they are never in an image, a unit file or this repository.

**Health check before announcing it.** After any deploy:

```sh
curl -s https://<domain>/health
curl -s https://<domain>/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"what_can_you_do","arguments":{}}}'
```
