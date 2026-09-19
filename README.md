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
* [api.weather.gov](https://www.weather.gov/documentation/services-web-api): official watches, warnings and
  advisories for each registered address, polled every ten minutes, including the instruction text written by the
  forecast office that issued them
* [openFDA drug enforcement reports](https://open.fda.gov/apis/drug/enforcement/): open recalls,
  matched against the medicines this person takes, checked every six hours in the background
* [FEMA and Red Cross National Shelter System](https://gis.fema.gov/arcgis/rest/services/NSS/FEMA_NSS/MapServer):
  the shelters open right now, nationally, with whether each has a generator, step-free access or takes
  pets. On an ordinary day that is a handful for the whole country, so the list is small enough to hold
  in memory and the distance arithmetic happens here

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

**Where the medication advice bends the usual rule.** A 2026 scoping review of medication and
heat-related illness in older adults, covering 61 primary studies, groups thiazides, SSRIs and the
renin-angiotensin drugs together as the class where ordinary hot-day advice can do harm: their risk
is hyponatremia, so the danger is too much plain water rather than too little
([Pharmacy 14(3):74, 2026](https://doi.org/10.3390/pharmacy14030074)). Those medicines now carry
their own mechanism here, and it outranks the general electrolyte line, so someone on a thiazide is
told to sip through the day and take something salty rather than to drink more water. A loop
diuretic, whose problem is a different one, still gets the ordinary advice.

## Tools

Eighteen tools. Fewer than there were, deliberately: published benchmarks put tool selection above 90 percent
up to about twenty tools and falling away after that, so adding and removing the same thing is one tool with an
action, not two.

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
* `weather_warnings` official National Weather Service alerts for their address, with the weather service's own
  instructions, and why this one is worse for them
* `storm_prep` what a storm or a power cut means for their medicines: refrigeration, dialysis, oxygen, supply
* `should_i_shovel` whether heavy work in the cold is a risk for this person
* `somewhere_to_go` open shelters near this address when the house is too cold or too hot to stay in,
  which ones have a generator, step-free access or take pets, and the 211 line for the local warming
  and cooling centres no federal list carries
* `what_can_you_do` including that it is not a doctor and not medical advice

**About you**
* `register_location` by city and state or zip code
* `medication` adds or removes one, by generic or brand name
* `health_condition` adds or removes one, the way people say it, "I have MS", "my husband is on dialysis"
* `my_profile` reads back everything it has been told, and `action forget` deletes all of it: the fresh
  start the certification requirements ask for, said back as counts rather than a list of medicines, and
  only done when asked a second time

Every tool also declares what it does to the world, in the annotations the specification carries:
whether it only reads, whether it can take something away, whether saying it twice changes anything,
and whether its answer depends on a service outside this process.
* `set_privacy` keeps medications and conditions out of spoken answers
* `log_outing` records how a trip outside went

**Family**
* `contact` adds, confirms or removes a family member or caregiver to email in an emergency or the evening
  before a stay-inside day. Nothing is sent to anyone unconfirmed

## When the house is the problem

A power cut in winter is not an inconvenience for everyone. The CDC puts the indoor floor at 68F and
says a house sitting at 60 to 65F can bring on hypothermia in an older adult, which is a temperature
most people would call chilly rather than dangerous, and it happens slowly enough not to register.
Their first answer is to go and stay with a relative or a friend. `somewhere_to_go` is for the person
who has nobody to ask.

It reads two sources because neither is enough alone. FEMA and the Red Cross publish the shelters
that are **open right now**, which is authoritative, national, free, and carries the three things that
decide whether a building is any use to a particular person: a generator, step-free access, and
whether a pet can come. Someone who will not leave a dog behind is someone who stays in a cold house.
What that feed does not carry is the city hall that opened its library for a cold snap, because it is
built for declared disasters. So every answer also gives 211, by phone and by text, which is the line
that does know about the library.

Three rules, all tested:

* **A failed check is never "nothing is open".** That sentence would send someone back into a cold
  house on the strength of a timeout. It says it could not find out, and hands over 211.
* **A blank in the feed is not a no.** If the generator field is empty and this person runs an oxygen
  concentrator, the answer says the list does not record one and to ask when they ring, rather than
  quietly leaving it out.
* **The relative or friend comes first**, because that is the CDC's own first line, and a test fails
  the build if a shelter name ever appears before it.

## One add-on asking another

The National Weather Service does not forecast the sun. A severe geomagnetic storm is the other way
a power grid gets into trouble, and NOAA's own scale says a G4 can bring "possible widespread
voltage control problems" and that at G5 "some grid systems may experience complete collapse or
blackouts" ([NOAA space weather scales](https://www.swpc.noaa.gov/noaa-scales-explanation)). For a
person keeping insulin between 36 and 46 degrees, or running an oxygen concentrator, that is a
medical question rather than an astronomical one.

Orbita already reads that forecast, and it is an MCP server, so Sudor talks to it the way a host
would: it opens a Streamable HTTP MCP client, calls the public `storm_status` tool twice an hour,
and reads the NOAA scale out of the answer. `storm_prep` then leads with the storm when one is
coming. `SUDOR_ORBITA_URL` points at the Orbita to ask; without it the feature is simply off.

Two rules make it safe, and both are tested against a stand-in Orbita that records everything it
receives:

* **Nothing personal goes the other way.** The call carries no arguments at all: no location, no
  medicines, no identifier. `test-spaceweather.mjs` reads the wire and fails if the word
  "medication", "lat", "email" or the demo city appears anywhere in the transcript.
* **A failure is silence, never an all clear.** Unreachable, slow, or an answer in an unexpected
  shape all mean the same thing: say nothing about space weather. Telling someone on home oxygen
  that the grid looks fine because a request timed out would be the worst thing this could do.

**And it stays quiet below G4, because the history says so.** The bar started at G3 until the record
was checked properly, and G3's grid line in the NOAA scale is "voltage corrections may be required,
false alarms triggered on some protection devices", which is a control room's afternoon, not a
household's. Even at G4 and G5 the base rate is that nothing happens: since the Quebec collapse of
March 1989 there has been one small regional outage from a geomagnetic storm in the developed world,
Malmo in October 2003, and North America has come through every storm since with the lights on,
including the G5 of May 2024, where the grid held across three days of G3 to G5 conditions. GMD
planning has been a mandatory NERC standard since 2016.

So the line is a nudge to charge things, never a forecast about anyone's street, it carries that
base rate every time it is said, and it comes at the end of the answer rather than in front of the
insulin. A test fails the build if it ever leads.

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

## Warnings, and what a storm means for a medicine cabinet

Sudor does not write safety advice for a flood. The forecast office that issued the alert already did, and their
words are better than anything this project would invent, so the weather service is quoted and the personal half
is added on top: which of these alerts is worse because of the medicines and conditions on file.

That personal half is the part nobody else can do:

* **Insulin needs 36 to 46 degrees.** If the power goes, the FDA's own guidance is that insulin kept too warm can
  still be used when there is nothing else, and that frozen insulin cannot. Telling someone to throw it away would be
  the dangerous answer.
* **Dialysis needs a clinic that is open.** Before the storm, ring the unit. If a treatment is missed, the National
  Kidney Foundation's three day emergency diet exists for exactly that.
* **Anything that plugs in needs a plan.** Oxygen concentrators and nebulisers stop when the power does.
* **A week of everything, written on paper**, because a phone with a flat battery cannot tell a paramedic anything.

A cold outage adds the warning that kills people after the storm rather than during it: no generator, grill or
camping stove indoors or in the garage.

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
```

Or without installing Node at all:

```bash
docker build -t sudor . && docker run -p 8789:8789 sudor
```

`npm test` runs everything, 573 checks. It is also what CI runs on every push, on Node 20 and 22,
with the live suite in its own job so an outage at a weather service is never mistaken for a
regression here.

```bash
npm run test:unit           # 340 checks, no live data
npm run test:live           # 233 checks, against the real forecast

node test.mjs               # 35: heat index formula, categories, medications, how the lines read aloud
node test-personal.mjs      # 84: conditions, an age said aloud, sensitivity, planning, precautions, first aid
node test-actions.mjs       # 47: removing, privacy, learned limits, contacts, emails, repeats, forgetting, retention
node test-panel.mjs         # 14: the MCP Apps handshake against a simulated host
node test-auth.mjs          # 23: OAuth 2.1 with PKCE against a running server
node test-static-client.mjs # 8: the account linking shape Alexa+ actually uses
node test-cold.mjs          # 27: wind chill against the NWS chart, frostbite times, hypothermia first aid
node test-recalls.mjs       # 21: FDA recalls, severity, privacy, and never a false all clear
node test-warnings.mjs      # 29: official alerts, the personal half, and storm prep by medicine
node test-spaceweather.mjs  # 30: asking Orbita over MCP, what crosses the wire, the base rate, silence on failure
node test-shelters.mjs      # 22: open shelters, distances, what the feed does not say, and 211
node test-web.mjs           # 58: the demo page, every request on it, one profile per visitor, older hosts
node test-contract.mjs      # 147: every listed tool invoked for real, on an empty profile and a half set
                            #       up one, with junk arguments, annotations checked, and every answer read
                            #       back for sentences that would stumble out loud
node test-latency.mjs       # 14: the voice budget, measured per tool, written to LATENCY.md
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

## What it keeps, and for how long

A public endpoint holds records for anyone who calls it, so three limits exist and each one is tested:

* **Reading never creates a record.** Any string can arrive as a demo id, and a read that created a
  record would be a tap a stranger could leave running.
* **Nothing grows without a ceiling.** Outings and the record of alerts already sent are both capped. The oldest entries go first, and the caps are far
  past what real use produces.
* **Demo profiles expire after a week.** Anything with a demo id and no write for seven days is swept daily,
  and these hold medicines, conditions and how somebody felt on a hot afternoon. A record belonging to a linked account is never swept: that one was asked for, and there is
  a tool to clear it on request.

Writes go to a temporary file and are renamed over the real one, which is atomic on a single
filesystem. A crash partway through a direct write leaves a truncated file that still parses, which
is worse than losing it outright because nothing complains.

The endpoint is rate limited per caller, a burst of 600 refilling at ten a second, which is far
above anything a conversation does and far below a script. The specification asks for it and we had
nothing.

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
