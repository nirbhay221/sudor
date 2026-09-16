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
    "install -m 644 /opt/sudor/deploy/sudor.service /etc/systemd/system/sudor.service",
    "systemctl daemon-reload", "systemctl restart sudor"]'
```

## What it costs

Nothing beyond the instance Orbita already pays for, plus pennies for the
gateway. The bundle sits in the same S3 bucket under a `sudor/` prefix.

## Choices worth knowing

**Its own service user and its own state directory.** `sudor` cannot read
Orbita's files and Orbita cannot read `/var/lib/sudor`, which holds people's
medications and conditions. The unit also runs with a read-only system, no home
directory access and no new privileges.

**No secrets on the box.** It reads its bundle from S3 and, when family email is
switched on, sends through SES using the instance role.

**Health check before announcing it.** After any deploy:

```sh
curl -s https://<domain>/health
curl -s https://<domain>/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"what_can_you_do","arguments":{}}}'
```
