# Friction log

Developer feedback from building Sudor, an Alexa+ MCP add-on, against the Alexa+ and MCP
documentation as they stood on 12 September 2026.

Severity is judged by effect on a developer trying to ship, not by how annoying it was.

---

## 1. Account linking is not the generic MCP OAuth shape it looks like it should be

**Severity: high. Building against the wrong shape would have shipped a linking flow that fails
the first time a real Alexa+ customer tries it.**

This is the same finding as Orbita's, this project's sibling, since both share one auth module.
Recorded here too because it cost real time on this build independently, and a submission's
product feedback should not hide a defect just because it was already found once elsewhere.

**Task.** Implement OAuth 2.1 account linking for the MCP endpoint.

**Steps.** Followed `mcp-toolkit-quickstart.html`, which documents PKCE and S256 in detail, and
built the shape every generic MCP OAuth library uses: Dynamic Client Registration (RFC 7591) so
any caller can self-register a `client_id`, plus a `WWW-Authenticate` 401 challenge pointing at
protected resource metadata (RFC 9728).

**Actual.** `category-sdk-mcp-account-linking.html` states plainly that Alexa+ "supports only the
Authorization Code Grant" and that "Dynamic Client Registration isn't supported." The developer
generates their own `client_id`, runs `alexa-ai configure-account-linking --client-id <id>`, and
the CLI returns Alexa's own set of redirect URIs, one per region, to register: "use exactly the
value Alexa passes, don't hardcode a single URI." Self-service DCR is the opposite shape: built
for many unknown clients, when Alexa+ is exactly one known client registered out of band.

**Workaround.** Added static client pre-registration from environment variables
(`SUDOR_CLIENT_ID`, `SUDOR_REDIRECT_URIS`) at server boot. DCR is kept only as a local-testing
fallback.

**Suggestion.** Same as Orbita's: cross-link `mcp-toolkit-quickstart.html` and
`category-sdk-mcp-account-linking.html`, or fold the account-linking shape into the QuickStart
directly, so a builder does not implement the wrong OAuth flow before finding the page that
corrects it.

---

## 2. Alexa+ add-ons cannot notify a customer on their own, which decided this project's entire shape

**Severity: informational, because it changed the design rather than blocking it, but it is the
single most consequential platform fact this project ran into.**

**Task.** Work out whether Sudor could warn a customer proactively when their registered location
crosses into a dangerous heat category, the way a weather app pushes a heat advisory.

**Steps.** Searched the MCP Toolkit Overview and the wider Alexa+ add-on documentation for a
proactive-notification or push capability equivalent to a skill's Proactive Events API.

**Actual.** The only documented proactive channel, `Alexa.ProactiveNotificationSource`, is scoped
to smart-home devices signalling their own state ("your washer cycle finished"), and even the
older skills-era Proactive Events API caps notifications per day and blocks them between 10pm and
7am local time. Nothing in the MCP add-on surface lets a self-hosted server initiate contact with
a customer; every tool call runs only because Alexa+ decided, from something the customer said, to
call it.

**Consequence for this project.** This is not a missing feature Sudor works around, it is why
every tool here is a question-and-answer tool rather than an alert. A design that assumed
proactive push would have been unbuildable on this platform, not merely degraded. Worth stating
directly in a submission's product feedback, because it is easy to read "no push notifications" as
a minor platform gap when for a safety-adjacent add-on like this one it is closer to a ceiling on
what the product can be at all.

**Suggestion.** If Alexa+ add-ons are meant to eventually cover conditions that change without the
customer asking, a scoped proactive channel for MCP add-ons, even one as rate-limited as the
skills-era API, would matter more here than in most categories, since heat risk is exactly the
kind of thing a customer will not think to ask about on the day it turns dangerous.

---

## 3. Two independent, real APIs both blow the round-trip budget alone, before this server does any work

**Severity: informational, recorded because it decided the architecture and is worth other
builders knowing before they design around live per-request calls.**

Measured directly, on 12 September 2026, before writing any server code: a single Open-Meteo
forecast call took 420 to 480 ms, and a single openFDA drug-label lookup took 660 ms. Alexa+
allows roughly 500 ms total for a round trip. Either number alone exceeds that budget with zero
room for this server's own logic, so both had to be ruled out for the request path entirely rather
than optimised. Weather is refreshed per registered location on a 20-minute background timer,
matching Orbita's approach to the same constraint with NOAA; medication classification never calls
a live API at all, and is instead a hand-built static table, because a lookup that cannot meet the
budget is not a fallback option, it is disqualified outright.

---

## 4. The Display Modes page points at the wrong place, and following it gives a panel that never renders

**Severity: high.**

The same finding as Orbita's entry 1, hit again here independently. The Alexa+ Display Modes page
says to "declare in your tool what you support". In the MCP Apps specification (2026-01-26) a tool
only links its view, with a nested `_meta.ui.resourceUri`; the view declares display modes in
`appCapabilities.availableDisplayModes` inside the `ui/initialize` request it sends, and the host
may not send the view anything until the view has also sent `ui/notifications/initialized`. This
project's first panel used a flat `'ui.resourceUri'` key and never sent `ui/initialize`, so it would
have stayed blank on a real host. `test-panel.mjs` now plays the host and checks the handshake.

**Suggestion.** Put the tool metadata, the `ui/initialize` request and the initialized notification
on the Display Modes page, with a link to the MCP Apps specification by version.

---

## 5. A spoken place takes longer to resolve than Alexa+ allows for the whole turn

**Severity: medium. It decided how location works.**

**Task.** Let a customer set their location by saying a city or a zip code, since nobody knows their
coordinates.

**Actual.** Open-Meteo's free geocoding API measured 740 to 1000 ms per lookup, against roughly
500 ms for a whole Alexa+ turn. The Alexa+ add-on documentation does not say how an add-on should
handle work that takes longer than one turn. MCP 2025-11-25 includes experimental tasks for long
running requests, but nothing in the Alexa+ docs says whether Alexa+ supports them.

**Workaround.** `register_location` answers at once ("Looking up Phoenix now, ask me about the heat
in a moment"), stores the place as locating, and resolves it in the background; the next question
finds it ready, still locating, or not found, and says which. A server restart finishes any lookup
it interrupted.

**Suggestion.** Document the supported pattern for work that outlasts a turn: whether MCP tasks are
honoured, and if not, the recommended way to acknowledge now and answer on the next turn.

---

## 6. Minor: Open-Meteo times carry no timezone, and JavaScript assumes the server's

**Severity: informational. Not an Amazon issue, recorded because it gave wrong answers.**

Without a `timezone` parameter Open-Meteo returns GMT wall clock strings such as `2026-09-12T15:00`
with no `Z`. `new Date()` reads a string without a zone as the machine's local time, so on a server
in Central time "when does it ease off" was five hours out, and would be wrong by a different amount
on every host. The server now requests `timezone=auto`, keeps the location's wall clock for what it
says, and converts each hour to a true UTC instant with the `utc_offset_seconds` Open-Meteo returns.

---

## 7. "Detect and prevent duplicate transactions" is a requirement, and the protocol gives a stateless server nothing to detect them with

**Severity: medium. The requirement is right, and meeting it is left entirely to guesswork.**

**Task.** Meet the functional requirement *"Detect and prevent duplicate transactions"*, whose own
example is a customer who already has a booking being offered a modification rather than a second one.

**Expected.** Somewhere in the add-on documentation, a sentence saying whether Alexa+ retries a tool
call it believes failed, and if so, what arrives with the retry that a server can recognise.

**Actual.** Nothing in the MCP add-on pages, the QuickStart or the functional requirements says
whether the host retries, on what timeout, or how many times. The protocol does not close the gap
either: a JSON-RPC id is unique per connection, and a stateless Streamable HTTP server sees a new
connection for every call, so the id is no help. There is no idempotency key in `tools/call`. The
result is that a server cannot tell a retried request from a customer saying the same sentence
twice, and both have to be handled the same way whether that is right or not.

The newest specification, 2026-07-28, confirms this rather than fixing it. It states plainly that
"MCP has no protocol-level session, so a server cannot rely on implicit per-connection state to
relate one tool call to the next", its guidance on carrying state is explicitly non-normative, and
where it does define a retry, for multi round-trip input, it requires the opposite of what
deduplication needs: "the JSON-RPC `id` MUST be different between the initial request and the
retry".

This was not theoretical here. Until this week, "I just got back and I felt unwell" said twice recorded two outings, because the write had no condition on it at all. The second answer was identical to the first, so nothing about it looked wrong.

**Workaround.** Treat identical writes inside a two minute window as one: an outing reported twice is recorded once, which matters here because an unwell outing sets the personal heat limit and a duplicate would weigh one bad afternoon twice. A retry
arrives in seconds, and nobody does the same thing twice that fast. The second answer says what
happened, in the shape the requirement's own example uses.

**Suggestion.** One sentence in the add-on documentation about host retry behaviour, and, if
retries happen, a stable request identifier carried in `_meta` so a server can recognise one. Until
then, every add-on that writes anything is inventing the same window, and choosing it differently.

---

## 8. Nothing says which Accept header the host sends, and the reference transport refuses the wildcard

**Severity: medium for anyone testing by hand. It reads as a broken endpoint.**

**Task.** Confirm the MCP endpoint answers, the way anyone would: `curl` it.

**Expected.** A JSON-RPC answer, or an error that says what is wrong.

**Actual.** `406 Not Acceptable: Client must accept both application/json and text/event-stream`.
The Streamable HTTP specification does ask clients to send both types, and the reference TypeScript
SDK enforces it by string match, so `Accept: */*`, which is curl's default and is what several HTTP
clients send, is refused although it accepts both types by definition. A developer's first contact
with their own server is a 406 that looks like a fault in the server.

The Alexa+ documentation does not say what its host sends, so there is no way to know from the docs
whether this matters in production or only on the bench.

**Workaround.** A wildcard, or a missing Accept, is widened to the pair the transport wants before
the request reaches it; an Accept that names `application/json` and nothing else is still refused,
because that client genuinely cannot read the event stream we answer with. Tested both ways in
`test-web.mjs`.

**Suggestion.** State the headers the Alexa+ host sends, and the protocol versions it will
negotiate, on the MCP Toolkit page. One table would remove an entire class of guesswork. The
wildcard case belongs upstream in the SDK, but the documentation gap is Amazon's to close.

---

## 9. When arguments fail validation, the protocol's own error text is what the customer hears

**Severity: medium. It breaks two functional requirements at once, and the default is to do nothing.**

**Task.** Make sure a mis-heard word produces something a customer can act on, as
*"Provide actionable next step for every error"* and *"Surface no API codes, tool names, JSON, or
internal IDs in any customer-facing response"* both require.

**Expected.** That a schema mismatch produces an error the host turns into a question.

**Actual.** The tool result that comes back is, verbatim:
`MCP error -32602: Input validation error: Invalid arguments for tool medication: Invalid enum value.
Expected 'add' | 'remove', received 'stopped'`. That string is the tool's output, so it
is what the host has to work from, and it contains an error code, a tool name and an internal enum.
Nothing in the documentation mentions this, and the default behaviour of the reference SDK breaks
both requirements without the developer doing anything wrong.

**Workaround.** The `tools/call` handler is wrapped, and a validation failure is rewritten into the
plainest true sentence: the choices we do have, at most five of them because the voice requirements
cap spoken options at five, with underscores removed and the rejected word never offered back as a
choice. `test-contract.mjs` calls every tool with arguments it never asked for and fails the build
if protocol text reaches the answer.

The specification is on the side of rewriting it. It sorts errors into protocol errors, for
"issues with the request structure itself that models are less likely to be able to fix", and tool
execution errors, which "contain actionable feedback that language models can use to self-correct",
and it lists "input validation errors (e.g., date in wrong format, value out of range)" under the
second kind. A schema mismatch arriving as a protocol error, with the code and the tool name in the
text, is the case the specification says should read as actionable feedback instead.

**Suggestion.** Say in the certification pages that a schema validation failure is customer-facing,
and recommend rewriting it. Better still, have the toolkit offer a hook for it, since every add-on
built on the reference SDK has this exact behaviour until someone notices.
