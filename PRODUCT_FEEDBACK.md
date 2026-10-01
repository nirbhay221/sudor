# Product feedback and AWS services

Written for the hackathon's product feedback field. The detailed, dated entries are in
[FRICTION.md](FRICTION.md); this is the summary, plus the AWS services Sudor uses and what each one does.

## What worked

* **The functional requirements page.** It is specific and testable, and it works as a build checklist: spoken
  options capped at five, an actionable next step on every error, and no protocol text in anything a customer
  hears all became tests here.
* **Streamable HTTP and the 2025-11-25 specification.** A stateless server (a new server and transport per
  request) is simple to reason about and runs on one small instance shared with a sibling add-on.
* **The MCP Apps model for the Echo Show panel**, once the handshake was understood (entry 4).

## What needs improvement

Each is a numbered entry in FRICTION.md with the task, steps, expected against actual, severity, workaround
and a suggestion.

1. Account linking is not the generic MCP OAuth shape; Dynamic Client Registration is not supported (entry 1, high).
2. MCP add-ons cannot notify a customer on their own, which for a heat-safety add-on is a ceiling on what the
   product can be (entry 2).
3. The round-trip budget is about 500 ms, and two real APIs each exceed it alone, so nothing live can be on the
   request path (entry 3).
4. The Display Modes page points at the wrong place and following it gives a panel that never renders
   (entry 4, high).
5. A spoken place takes longer to resolve than the whole turn is allowed, and the documentation does not say
   whether MCP tasks are honoured (entry 5).
6. Nothing says whether the host retries a tool call, so "detect and prevent duplicate transactions" cannot be
   met reliably by a stateless server (entry 7).
7. Nothing says which `Accept` header or protocol versions the host sends (entry 8).
8. A schema validation failure reaches the customer as protocol text unless the developer rewrites it (entry 9).

## Onboarding experience

The documentation was good once found. The cost was in the gaps above, and in the add-on path being a gated
preview: it could not be tested on a real Echo, so Sudor ships with a stand-in model that plays Alexa+'s part
and says so in its own responses.

## Future use

Sudor would use a proactive channel for MCP add-ons, a documented host retry identifier, and a documented
supported pattern for work that outlasts a turn.

## AWS services used

| Service | What it does here |
|---|---|
| EC2 (t4g.micro) | Runs the MCP server and the demo page, shared with the sibling add-on Orbita |
| API Gateway (HTTP API) | The public HTTPS address in front of the instance |
| Systems Manager Parameter Store (SecureString) | Holds the data-at-rest key for people's medication and condition records, and the origin secret |
| Systems Manager (Run Command) | Deploys without SSH or keys |
| S3 | Holds the application bundle the instance pulls |
| IAM | An instance role limited to the bundle, the two parameter prefixes, SES and Polly |
| SES (v2) | Emails a confirmed family contact when signs of heat stroke are described, or the evening before a day that stays too hot |
| Polly | Speaks the same sentence the tool returns, on the demo page, with per-caller and daily caps |

Not used: Bedrock and CloudFront. The stand-in model calls Anthropic's API directly, and the public address is an
API Gateway HTTP API (see `deploy/README.md`).
