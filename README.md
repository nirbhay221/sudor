# Sudor

**"Alexa, when is the best time for me to go out today?"**

An Alexa+ add-on that plans a day around the heat for one person's own body: the medications
they take and the health conditions they have, against the live heat, UV and air quality where
they are. It finds the best time to go out, says what to do when going out cannot wait, and knows
the warning signs of heat illness, including when the answer is to call 911.

The Latin `sudor` is sweat, the thing several of these medications and conditions quietly take
away.

Built for the [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com),
Alexa+ track, plus the Open Source and AWS Builder mini challenges. Self-hosted MCP server,
spec 2025-11-25, Streamable HTTP, with an MCP Apps panel for the Echo Show.

## The problem

A heat advisory is written for everyone, and everyone is the wrong threshold for a lot of people.

* The CDC names adults 65 and over, pregnant people and people with chronic conditions as more
  prone to heat illness
* Common medications change how a body handles heat: beta blockers and some antipsychotics block
  sweating, ACE inhibitors and some antidepressants blunt thirst, diuretics disturb electrolytes,
  and thiazides and some antibiotics make skin burn faster
* Heat sensitivity affects 60 to 80 percent of people with multiple sclerosis
* Heat is the usual trigger for erythromelalgia flares, and the standard cooling advice, ice, damages
  their skin
* A spinal cord injury takes sweating away below the injury
* On hot afternoons ozone rises, which is hard on heart and lung conditions

The NWS and CDC HeatRisk scale says it plainly: heat that is "tolerated by most" already carries
risk for extremely heat-sensitive people. Nothing holds a person's own medications and conditions
against their own local forecast and turns that into a plan for the day.

## What it does

Real output from `probe.mjs`, against live Phoenix, Arizona weather on 12 September 2026, for
someone who said they take metoprolol and lisinopril and have multiple sclerosis:

```
"Alexa, when should I take a walk today?"

"It stays hot for you all day, with multiple sclerosis. If you need to go,
 9 to 10 pm is the least risky, heat index about 91, and ask me what
 precautions to take."
```

```
"Alexa, I have to go out now."

"It is heat index 100 right now. Keep it as short as you can, and stay in shade
 or air conditioning on the way. Cool down before you go, and take something to
 stay cool, like a cooling vest, a neck wrap or a cold drink. Your medication
 blocks your sweating, so you may not get the usual warning signs of overheating
 before it is serious. ... I have 2 more, ask me for the rest. If you or anyone
 with you becomes confused, slurs their words or faints, that can be heat stroke:
 call 911."
```

```
"Alexa, my dad seems confused and his skin is hot and dry."

"That can be heat stroke, which is an emergency. Call 911 now. While you wait,
 move them somewhere cool and cool them with cool wet cloths or a cool bath.
 Do not give them anything to drink."
```

## Why it is not a wrapper around a weather app

**Who you are decides the threshold.** Sensitivity is graded the way HeatRisk grades people, one
level apart: everyone else, sensitive, and extremely sensitive. The same hour at heat index 84 is
fine for most people, a time for care for someone with diabetes, and better spent inside with MS.
Blocked sweating from a medication puts someone in the extremely sensitive group on its own.

**The plan always names a time.** Every stretch long enough for the errand is scored by its worst
hour, then its hottest. On a comfortable day that is the whole comfortable stretch; on a day that
stays hot for you it is still the least risky hour, with an offer of precautions, because "no time
is safe" leaves a person with nothing to plan around.

**The advice changes where generic advice does harm.** Erythromelalgia gets cool water, never ice.
Kidney disease gets "follow your fluid plan", never "drink more". A medication that blunts thirst
gets "sip on a schedule". Insulin is kept below 86 degrees. Heart and lung conditions get air
quality, and a medication that sensitises skin gets UV.

**It never tells anyone to stop a medication.** Whenever a medication is named as the risk, it says
not to stop or change it because of the heat without asking a doctor or pharmacist.

**The warning signs err toward the call.** Confusion, slurred speech, fainting, hot dry skin or a
temperature above 103 get "call 911, nothing to drink" immediately. Heat exhaustion gets cooling,
sipping water, and help if it lasts past an hour or they vomit. Fainting appears in both official
lists and is treated as the emergency.

## Conditions

| Condition | Group | What changes | Source |
|---|---|---|---|
| Multiple sclerosis | extremely sensitive | pre-cooling; heat symptoms usually settle within a day, a new one that does not needs a doctor | StatPearls, Uhthoff phenomenon; MS Trust |
| Erythromelalgia | extremely sensitive | cool water or a fan, never ice or cold water | StatPearls; The Erythromelalgia Association |
| Spinal cord injury | extremely sensitive | bring external cooling, sweating is reduced below the injury | Frontiers in Sports and Active Living (2019) |
| POTS, dysautonomia | sensitive | avoid standing still in the heat | Autonomic Neuroscience |
| Heart disease | sensitive | air quality counts; nothing strenuous | CDC |
| Asthma, COPD | sensitive | ozone peaks in the afternoon; action plan and quick relief medicine | AirNow Air Quality Guide for Ozone |
| Kidney disease, dialysis | sensitive | follow the care team's fluid plan | CDC |
| Diabetes | sensitive | insulin below 86 degrees; check blood sugar more often | American Diabetes Association |
| Pregnancy | sensitive | even one day of high heat raises risk | CDC |
| Age 65 or over | sensitive | cooler hours, keep it short | CDC |

Plus 48 medications classified by heat mechanism from the CDC's clinical guidance on heat and
medications.

## Data

Free sources, no API keys.

* [Open-Meteo](https://open-meteo.com) forecast: hourly temperature, humidity, UV index and daylight
  for today and tomorrow, requested in the location's own timezone
* Open-Meteo air quality: hourly US AQI, joined to the forecast by hour
* Open-Meteo geocoding: a spoken city and state, or a US zip code, into coordinates
* [openFDA drug enforcement reports](https://open.fda.gov/apis/drug/enforcement/): open recalls,
  matched against the medicines this person takes, checked every six hours in the background

Measured before choosing the architecture: a forecast call took 420 to 480 ms, the forecast and air
quality calls together 772 ms, and a geocoding lookup 740 to 1000 ms. Alexa+ allows roughly 500 ms
for a whole turn. So nothing external is ever called inside a tool call. Weather refreshes per
location on a 20 minute background timer. A spoken place answers at once ("Looking up Phoenix now")
and resolves in the background, and a server restart finishes any lookup it cut off.

**Times are said where the person lives.** Open-Meteo returns wall clock strings with no timezone
marker, and JavaScript reads those as the server's own local time, which once put "when does it ease
off" five hours out. Every hour now keeps the location's wall clock for speaking and a true UTC
instant for comparing.

The heat index is the NWS Rothfusz regression, the formula behind the official chart, not
Open-Meteo's apparent temperature, because the NWS categories were built on the NWS number.

## Tools

Seventeen tools.

**Answers**
* `plan_my_day` the best time to go out today or tomorrow for an errand of a given length, and the
  hours to avoid
* `going_out_now` precautions for going out when it cannot wait, three at a time, always ending on
  the heat stroke line
* `warning_signs` what to do for the symptoms someone describes, or the signs to watch for, and
  in an emergency it emails confirmed emergency contacts after the 911 line
* `weather_check` whether right now is fine, a time for care, or better spent inside, and why
* `sun_check` sunburn risk from UV for a photosensitising medication
* `medicine_recalls` open FDA recalls on the medicines this person actually takes, worst first
* `what_can_you_do` including that it is not a doctor and not medical advice

**About you**
* `register_location` by city and state or zip code
* `register_medication` and `remove_medication` by generic or brand name
* `register_condition` and `remove_condition` the way people say it, "I have MS", "my husband is on
  dialysis"
* `my_profile` reads back everything it has been told
* `set_privacy` keeps medications and conditions out of spoken answers
* `log_outing` records how a trip outside went

**Family**
* `add_contact` stages a family member or caregiver to email in an emergency, the evening before a
  stay-inside day, or both, and `confirm_contact` confirms them. Nothing is sent to anyone
  unconfirmed
* `remove_contact`

## Family, privacy, and learning from a bad afternoon

**Telling someone.** An add-on cannot make an Echo speak first, so the server does it. When warning
signs describe heat stroke, the answer says to call 911 first, then confirmed emergency contacts are
emailed. In the evening where the person lives, if tomorrow stays in the risky range for them all
day, confirmed contacts get one email for that day. Contacts are staged and only emailed after the
person confirms. Email goes through Amazon SES when `SUDOR_EMAIL_FROM` is set to a verified sender;
until then every message is still written to `data/outbox.jsonl` and the spoken answer says it
cannot email yet, rather than claiming it did.

**Privacy mode.** A home is not a private screen: an aide, a neighbour or a grandchild may be in the
room. With privacy on, answers say "something in your health profile makes this heat riskier"
instead of naming a condition or medication, and personal precautions are held back until the
person asks for their private precautions. The heat stroke line is never held back.

**Learning.** "I felt dizzy out there" records the heat index at the time and makes it that
person's limit from then on. It only ever tightens: one fine afternoon is not evidence the next one
will be safe, so feeling fine never loosens anything.

**Taking things back out.** Medications, conditions and contacts can all be removed. Before this, a
stopped medication kept shaping every answer forever.

## Recalls on the medicines you take

Sudor already holds the one thing a recall notice needs to be useful: the list. A recall is published
against a drug name and a set of lot numbers, and the person who needs to hear it is whoever has that
bottle in the cupboard. Nobody's assistant is watching that list for them.

The openFDA enforcement feed is checked in the background, every six hours, for every medicine anyone
has registered, and answers come from memory. One query measured about 450 ms, which is the whole voice
turn, so it could never have run inside a tool call.

Three rules shape it:

* **It never says to stop taking anything.** A recall usually affects particular batches, and stopping a
  blood pressure tablet over a batch you do not have is its own harm. It says to check the lot number on
  the bottle and ask the pharmacist, and a class one recall says to ring them today.
* **A failed check is never an all clear.** An early version cached an empty result when the FDA could
  not be reached, which turned "I could not look" into "nothing is recalled". A test now fails if that
  ever comes back.
* **It counts medicines, not notices.** One medicine can carry several notices, and telling someone who
  takes two that four of their medicines are recalled is the kind of thing that ends trust in one
  sentence.

Medicines the heat table does not recognise are watched by name anyway. Heat advice needs a known
mechanism; a recall only needs the name on the bottle.

## The Echo Show panel

`ui://sudor/window.html` is an MCP App, specification 2026-01-26: nested `_meta.ui.resourceUri` on
the tools, `ui/initialize` declaring inline and fullscreen, `ui/notifications/initialized`, then
tool results. It shows the heat index for this person, and an hourly strip where every hour carries
a word (ok, care, stay in) and a fill pattern as well as a colour. Until data arrives it shows a
labelled example day. `test-panel.mjs` runs it against a simulated host.

## The demo page

`npm start` also serves a page at http://localhost:8789 for anyone who wants to try this without an Echo.
It is not a mock. Every request on it is a real tool call against this server and the live forecast for
the demo address, and the panel beside it is the same file the add-on serves, driven through the real
MCP Apps handshake rather than pasted in as a screenshot.

Three decisions worth naming:

* **Every visitor gets their own profile.** The page gives each browser an id and sends it as a header,
  and the server scopes storage to it. A profile holds medications and conditions, so a shared one would
  mean showing one visitor another visitor's health list.
* **It says what it is.** Alexa is not in the loop on that page, and the page says so rather than implying
  a device is answering. It also says, before anything else, that this is not medical advice.
* **The emergency path is on the page.** One of the requests describes heat stroke, so a visitor can see
  for themselves that the answer opens with 911 rather than burying it.

The requests live in `web/requests.json` rather than inside the page's code, so `test-web.mjs` can call
every one of them against a running server. A renamed tool or a changed argument fails a test instead of
failing quietly in front of someone.

## Running it

```bash
npm install
npm run build
npm start                   # demo page on http://localhost:8789, MCP endpoint on /mcp

node test.mjs               # 31 tests: heat index formula, categories, medications
node test-personal.mjs      # 74 tests: conditions, sensitivity, planning, precautions, first aid, places, timezones, tools
node test-actions.mjs       # 28 tests: removing, privacy mode, learned limits, contacts, emergency and stay-inside emails
node test-panel.mjs         # 14 tests: the MCP Apps handshake against a simulated host
node test-auth.mjs          # 23 tests: OAuth 2.1 with PKCE against a running server
node test-static-client.mjs # 8 tests: the account linking shape Alexa+ actually uses
node test-recalls.mjs       # 21 tests: FDA recalls, severity, privacy, and never a false all clear
node test-web.mjs           # 48 tests: the demo page, every request on it, one profile per visitor
node probe.mjs              # end to end against live Open-Meteo and geocoding
```

Alexa+ account linking is not the generic MCP OAuth shape: Amazon's docs state that it "supports
only the Authorization Code Grant" and that "Dynamic Client Registration isn't supported." Pick
your own `client_id`, run `alexa-ai configure-account-linking --client-id <id>`, and set the
redirect URIs the CLI hands back:

```bash
export SUDOR_CLIENT_ID=sudor-alexa-addon
export SUDOR_REDIRECT_URIS="https://layla.amazon.com/api/skill/link/...,https://pitangui.amazon.com/api/skill/link/..."
export SUDOR_AUTH=on
```

Expose it with `cloudflared tunnel --url http://localhost:8789`, then link it through
[`KayLerch/alexa-skill-mcp-bridge`](https://github.com/KayLerch/alexa-skill-mcp-bridge), the same
way as its sibling project [Orbita](https://github.com/nirbhay221/orbita).

## Performance

Alexa+ allows roughly 500 ms for a full round trip. Measured against live data on 12 September
2026: every tool answered in 3 to 8 ms, and the slowest request in the whole probe, setting a
location by voice, took about 50 ms including starting its background lookup. On 13 September, with
all seventeen tools, the contact, privacy and outing tools answered in 4 to 7 ms. Emails are sent
after the answer, never inside it.

## Prior art

Named deliberately, because it exists.

* The CDC's HeatRisk tool gives a daily risk level by zip code, for broad groups. It does not know a
  person's medications or conditions, or plan their errands.
* [`heat-guard`](https://github.com/apple2723/heat-guard) is a Streamlit web app with safer outdoor
  windows by hour and hydration plans for outdoor workers and students. It is not voice, and it does
  not account for medications or health conditions.
* [`alexa-heatindex-lambda`](https://github.com/jmhardison/alexa-heatindex-lambda), from 2017, reads
  out the heat index.
* General weather MCP servers such as [`measure-space-mcp-server`](https://github.com/MeasureSpace/measure-space-mcp-server)
  expose forecasts and air quality with paid keys.
* Searched GitHub on 12 September 2026: `heat illness mcp`, `heatrisk mcp`, `heat stroke warning
  signs alexa` and `extreme heat medication app` returned nothing.
* This is not a native Alexa+ feature. Alexa+ can read a heat advisory, or talk about a named drug in
  the abstract. It does not hold a person's medications and conditions against their own hourly
  forecast, and an add-on cannot speak first, so this answers when asked.

## Honest limitations

* The one level offset between sensitivity groups follows HeatRisk's own grouping, applied to the NWS
  heat index categories. That is an approximation, not a clinical threshold for any one person.
* Ten conditions and 48 medications, not a clinical database. Anything unrecognised is said to be
  unrecognised, never guessed.
* It is not a doctor and not medical advice. The warning signs follow NWS and CDC first aid wording
  and send emergencies to 911; they do not diagnose.
* Air quality is a forecast model, not a monitor on the person's street.
* It plans waking hours, 6 am to 10 pm, and the heat index is one number for one point. Shade, air
  conditioning and exertion change real risk.
* Places are US only, because Alexa+ is.
* Family email needs Amazon SES with a verified sender, and while an account is in the SES sandbox
  every recipient must be verified too.
* A learned limit comes from what the person reports, not a measurement, and it only tightens.
* Seventeen tools is a lot for a model to choose between. Descriptions carry the words people
  actually say, but tool choice on real Alexa+ still has to be tested.

## Licence

AGPL-3.0. Copyleft, deliberately, the same reasoning as Orbita: this protects the code, not the
idea, and the commit history is the record of when it was done.
