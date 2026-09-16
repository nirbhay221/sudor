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
