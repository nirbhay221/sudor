# Sudor

**Heat, cold and disasters, checked against your own medicines.**

> **You:** Alexa, is it safe for me to go out?<br>
> **Alexa:** For you, it is better to stay in right now if you can. It feels like 109 degrees out, which the
> weather service calls danger. Your metoprolol blocks your sweating, so you may not feel overheating until it
> is serious. Keep taking it unless your doctor says otherwise. Staying in only helps if your cooling works.
> Is it working?

**Try it:** [talk to it on a screen, with the family's phone beside it](https://2f2opzcjui.execute-api.us-east-1.amazonaws.com/echo.html)
(press **Speak**, or type) ·
MCP endpoint `https://2f2opzcjui.execute-api.us-east-1.amazonaws.com/mcp` (account linking) ·
[health](https://2f2opzcjui.execute-api.us-east-1.amazonaws.com/health)

Water pills, beta blockers, some antidepressants and seventeen conditions change what heat and cold do to a
body. A weather app tells everybody the same thing. Sudor is an Alexa+ add-on that remembers one person's
medicines, conditions, home and town, and answers for that person:

| Ask | What happens |
|---|---|
| "Is it safe for me to go out?" | A verdict for this body, with what is driving it |
| "When should I walk the dog?" | The safest hours today or tomorrow |
| "I feel dizzy and confused" | First aid at once; heat stroke signs get the emergency number for the country and the nearest hospital, and the family is emailed |
| "What do I do about this hurricane warning?" | The official warning where they live, turned into steps for them: insulin, oxygen, dialysis, whether to leave |
| "My air conditioning is broken" or "the power keeps cutting out" | Stops saying "stay in" when indoors is the danger, and warns about nights that stay too hot to recover |
| "I live alone" | On a dangerous day with no word from them by 2 pm, a family member who agreed is asked to check on them |
| "I'm keeping the Ramadan fast" | Drinking between sunset and dawn, the hottest hours indoors, and "break your fast" in first aid |
| "I have hay fever" | A thunderstorm in pollen season is warned about, because it can set off a severe asthma attack |
| "Tell my daughter I need help" / "Tell them I'm safe" | Email, and a text if she added her number, only after she agreed |

Built for the [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com),
Alexa+ track, plus the Open Source and AWS Builder mini challenges. Self-hosted MCP server, spec 2025-11-25,
Streamable HTTP, 13 tools by default, with an MCP Apps panel for the Echo Show. Its sister add-on
[Orbita](https://github.com/nirbhay221/orbita) does the same for GPS-guided field work, and the two talk to
each other.

## One afternoon

Dolores is 74, lives alone in Phoenix and takes metoprolol for her heart. It is 110 degrees out, and at two in the
afternoon her air conditioner stops. Her daughter Priya lives across town and agreed to hear from Sudor on bad days.

| Dolores says | Sudor |
|---|---|
| "Alexa, is it safe for me to go out today?" | Not for her: what it feels like outside, that her metoprolol blocks sweating so she may not feel overheating until it is serious, and to keep taking it |
| "My air conditioner just stopped working." | Indoors is no longer the safe place: the home will not cool down tonight. It points her somewhere cool, and Priya is emailed once that the home is too hot to stay in, with nothing about her health in it |
| "Where can I go then?" | The nearest cooling centre open today, by name and hours, from the county's own list |
| Half an hour later, about something else | It asks first: "Earlier I said your home was too hot to stay in. If you are still there, want me to find somewhere cool now?" |
| "Ummm, actually I feel a bit dizzy." | First aid at once, and the signs that mean calling 911 |
| Priya, from her own phone: "How is Mum doing today?" | What to do this afternoon: the home is too hot, call or go round, check the room, make sure she drinks. Never her medicine |

**The model talks; code decides.** The assistant's job is to understand Dolores. Every answer, every number and
every safety line is written by code from live public data and published guidance, so no model can soften "call
911" or turn "stay in" into "probably fine". Three rules hold everywhere: it never says it is safe when it could not
check, it never tells anyone to stop a medicine, and nothing is sent to anyone who has not agreed.

**Tested the way people talk.** Older adults recorded using voice assistants at home repeated themselves, said
"never mind", asked "what about tomorrow though?" and "why?" (arXiv 2403.02421, 2510.06690). Fourteen conversations
in those patterns, played turn by turn against the real tools with the model seeing every earlier answer, got 33 of
34 turns right on Opus, and the one it read differently was a fair reading (`conversations.mjs`,
`evals/conversations-last-run.json`).

## What is real, and what is not

Nothing here is mocked for the demo. Where something stands in for a thing we could not reach, it is named.

| Part | Status |
|---|---|
| MCP server, 13 tools by default | **Real and deployed** on AWS, behind account linking. 2,272 automated checks, run on every push |
| Agent Skill | **Real**: `skills/sudor-heat-safety`, to the open Agent Skills format, passing the format's own validator. Installable as a folder, and readable from the server as `skill://` resources |
| Strands agent | **Real**: `strands/agent.mjs`, on AWS's Strands Agents SDK. It reads the skill from the server and follows each next step. The chain, the yes before a write and the step cap are checked with a scripted model at no cost; the path through Claude needs a key and is not in the automated checks |
| Weather, UV, air quality | **Real, live**: Open-Meteo, worldwide |
| Cooling centres | **Real, live**: twenty-three open lists published by Maricopa County, New York City, New York State, Washington DC, Harris County, Riverside County, the City of Los Angeles, Philadelphia, San Diego County, Maryland, San Antonio, Columbus, Cuyahoga County, Rhode Island, Toronto, British Columbia, Milwaukee, Chester and York Counties in Pennsylvania, Johnson County in Kansas, Lake County in Illinois, Ramsey County in Minnesota and Lincoln. Everywhere else the answer gives open shelters and the 211 line |
| Power already out at the address | **Real, live, where a list is published**: California's Office of Emergency Services, Duke Energy (the Carolinas, Florida, Indiana, Ohio and Kentucky) and BC Hydro. Where only county counts are published (Maryland, Pennsylvania, Ohio, and Alliant Energy in Iowa and Wisconsin) a large outage in the county is said as the county, never as the street |
| Official warnings | **Real, live**: the National Weather Service in the US, MeteoAlarm in Europe, INMET in Brazil, SACHET in India, and the WMO Severe Weather Information Centre elsewhere. In the US also the Weather Service's 7-day HeatRisk, the hurricane centre's cones and river flood forecasts |
| Medicines | **Real sources**: the CDC's clinical guidance on heat and medications, and the National Library of Medicine's RxClass for every other name, by drug class. Brand names from the regulators of India, Canada, France, Brazil, Italy, Spain and the United Kingdom. Measured against the 286 most prescribed ingredients in the US (ClinCalc, 2024): 119 recognised; the rest are mostly drugs the CDC lists no heat effect for. `node evals/coverage.mjs` re-runs it |
| Medicine and equipment recalls | **Real, live**: openFDA drug and device enforcement reports |
| Nearest emergency department | **Real**: Amazon Location Service, confirmed against Medicare's hospital list in the US |
| Emails to family | **Real**, through Amazon SES, only after the recipient agrees. The account is in the SES sandbox (production access requested), so today it reaches verified addresses only. The public demo never sends email; it shows the message on a phone panel instead |
| Text messages to family | **Real code**, through Amazon SNS, for urgent messages only, to a number the family member typed in themselves. Switched on; while the account's SMS is in its sandbox only verified numbers receive them |
| The talking demo | **Real model**: Claude Sonnet 5.5 reads the server's real tool list and picks a tool, as Alexa+ would. When no model is available, plain word rules pick instead, and the screen says which. Speech in and out is the browser's own |
| Alexa+ itself | **Not available to us.** MCP add-on access is in preview. Routing measured on the demo is that model's, not Alexa+'s |
| Phone calls | **Not built.** It cannot ring anyone, and says so |

**Where it works:** anywhere. The United States is matched first when a place is ambiguous, because that is where
Alexa+ is sold. Outside it, the emergency number is the local one (999 in London, 112 across Europe, 000 in
Australia), temperatures are said in Celsius as well, and the US shelter list and 211 line are replaced by the local
council.

## Start here

This file is long because the reasoning is the work. If you are evaluating the project:

| If you want | Read |
|---|---|
| To try it in two minutes | [The demo page](#the-demo-page) |
| What it does, in one exchange | [What it does](#what-it-does) |
| Why it is not a wrapper around a weather app | [Why it is not a wrapper around a weather app](#why-it-is-not-a-wrapper-around-a-weather-app) |
| Disasters, for one person | [Warnings, and what a storm means for a medicine cabinet](#warnings-and-what-a-storm-means-for-a-medicine-cabinet) |
| When home is the problem | [When the house is the problem](#when-the-house-is-the-problem) |
| Where it is wrong, or cannot know | [Honest limitations](#honest-limitations) |

Free sources, no API keys for the data. Every tool call is answered from memory; nothing external is called
inside a turn. `npm test` runs 2,272 checks.

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

"It feels like 100 degrees right now. Keep it as short as you can, and stay in
 shade or air conditioning on the way. Cool down before you go, and take something
 to stay cool, like a cooling vest, a neck wrap or a cold drink. If you or anyone
 with you becomes confused, slurs their words or faints, that can be heat stroke:
 call 911. I have 3 more, if you want them."
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
| Age 65 or over | sensitive | cooler hours, keep it short; past the limit measured for older adults, stay in | CDC; Wolf et al. (2023) |
| Dementia | extremely sensitive | the person may not notice heat or thirst, so drinks offered and the room checked; the family gets a step of its own, without the condition named | Conte Keivabu et al. (2024); JAMA Internal Medicine (2025) |
| A baby or young child with you | sensitive | the day planned at the child's sensitivity; never left in a parked car; loose light clothes; drinks, not very cold or sugary | CDC, Infants and Children and Heat |
| Sickle cell disease | extremely sensitive | a sudden swing in temperature either way can set off a pain crisis, so the hours to avoid are the ones where it swings | NIH; studies of weather and crises in children |
| Raynaud's | sensitive | cold is the trigger, and air conditioning can be too: something warm even on a hot day | NIAMS |
| Fasting | sensitive | time outside early or after sunset, drinking between sunset and dawn, "break your fast" in first aid | IDF-DAR; review of fasting in kidney disease |
| Hay fever | general | morning and windy days kept short; a thunderstorm in pollen season is warned about | Victoria Department of Health |
| Migraine | general | drink steadily; a forecast pressure drop is mentioned, as "can" | studies of weather and headache |

Plus 71 medications in Sudor's own table, classified by heat mechanism: 57 from the CDC's clinical guidance on
heat and medications and 14 added from the CDC's classes and FDA labels, with anything else looked up by class.

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
* [openFDA device enforcement reports](https://open.fda.gov/apis/device/enforcement/): the same, for
  the equipment a hot day is dangerous without. See [Equipment, not only
  medicines](#equipment-not-only-medicines)
* Open-Meteo radiation and wet bulb, on the call already being made, which is what turns a heat index
  into a WBGT. See [The number that knows the sun is out](#the-number-that-knows-the-sun-is-out)
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

## The two classes that were missing

Until recently this table had 48 medications and none of them were GLP-1 agonists or
SGLT2 inhibitors. Between them that is Ozempic, Wegovy, Mounjaro, Zepbound, Jardiance
and Farxiga: the most prescribed new drugs in the country and a first line diabetes
class, absent from a product whose entire premise is that a person's own medicines
change what heat does to them. That was a hole rather than a rounding error, and it is
recorded here rather than quietly filled.

Both lose fluid, and neither does it by sweating, which is why they needed a mechanism
of their own rather than being folded into the electrolyte case.

A **GLP-1 agonist** delays gastric emptying, and the reported consequence is nausea,
vomiting or loose stools. That loses fluid twice over: once out, and once because
somebody who feels sick does not want to drink. The literature ties it to significant
dehydration and secondary acute renal impairment, and the standing advice is to drink
plenty to avoid volume depletion.

An **SGLT2 inhibitor** does it through the kidney. Glucose in the urine drives an
osmotic diuresis and free water goes with it. Volume depletion events are measurably
more common in patients over 75, which is much of this audience, and the published note
is explicit that type 2 diabetes already carries a raised dehydration risk in hot
weather. Nobody calls these water pills, so they will not come up when somebody is
asked whether they take a diuretic.

**The advice had to be different, and that is the whole reason this is a section.**
For a thiazide, salt is what left, so an electrolyte drink is the correction. Here
water left by a route that took no salt with it, so the thiazide line would be
confidently wrong. What these get instead is steady plain fluid whether or not they
feel like it, and one escalation: not being able to keep fluids down in heat is a
reason to call somebody rather than wait it out. Forty eight tests exist to hold those
two pieces of advice apart.

## The number that knows the sun is out

Sudor answered with the NWS heat index for a long time. The heat index is the right tool for a great
many things and it is the scale the public knows, and the Rothfusz regression it comes from assumes a
person standing in the shade with a light breeze.

Nobody in this product is standing in the shade. That is the thing they are asking whether to leave.

WBGT, the wet bulb globe temperature, accounts for the rest of it: radiant load from direct sun, and
wind. On a clear afternoon the two disagree by 10 to 15 degrees Fahrenheit, and they disagree in the
dangerous direction, because the heat index is the lower one. For somebody whose medication has taken
their sweating away, being told 88 when the load on their body is 100 is not a rounding error.

It also settles a standards question. OSHA, NIOSH and the ACGIH all write occupational heat limits
against WBGT, not the heat index. The proposed OSHA heat rule triggers at a heat index of 80F *or* a
WBGT at the NIOSH recommended alert limit, and its high heat trigger at 90F *or* the recommended
exposure limit. A product that knows only one of those numbers can answer only half of its own rule.

**Where the numbers come from, and how much to trust them.** True WBGT is a measurement taken with
three physical thermometers, and nobody has those in their garden, so it has to be estimated. Every
estimate is somebody's published approximation with a stated error, so each one is named rather than
blended into a number nobody can check. The dry bulb and the wet bulb are not estimated at all:
Open-Meteo publishes the psychrometric wet bulb directly, on the same call. Globe temperature follows
Hunter and Minyard (1999). Natural wet bulb follows Malchaire (1976). The authoritative method is
Liljegren et al. (2008), which solves the heat balance iteratively rather than fitting a line through
it; this is deliberately not that, it sits within one or two degrees Celsius of it outdoors, and
`approximate: true` rides on every result so nothing downstream can forget.

**What is never said.** A WBGT and a heat index are not the same scale, and this is the easiest thing
here to get wrong. A heat index of 95 is a warm afternoon. A WBGT of 95 is past every occupational
limit there is. "Wet bulb globe temperature 97, against a heat index of 118" is true, reads as
reassuring, and is the reverse of the truth. So the raw WBGT number is never spoken next to the heat
index and never offered as a temperature to compare with the one on somebody's phone. What is safe to
say is the difference between sun and shade, because that is one scale, and it is the only part a
person can act on: stand somewhere else.

## Equipment, not only medicines

A drug recall is half of what can be pulled out from under this customer. The other half is the
equipment a power cut already makes dangerous, and this README already names it: insulin that has to
stay below 86 degrees, an oxygen concentrator that needs a socket, a dialysis chair that needs a
working clinic.

The FDA publishes device enforcement reports on the same API in the same shape, and a Class I device
recall means a reasonable probability of serious injury or death. Live, today, there are ongoing Class
I recalls affecting oxygen concentrators, insulin pumps, CPAP and ventilator equipment, and dialysis
catheters.

The matching problem is genuinely different from drugs, which is why it is a separate module. A drug
has a generic name and openFDA indexes it, so "lisinopril" is a precise query. Devices have no such
field: the only searchable text is `product_description`, free text written by the manufacturer, which
reads like "MAHURKAR 12 Fr High Pressure Triple Lumen Acute Dialysis Catheter, 24 cm, Straight
Extensions, IC Tray REF: 8888102004HP".

Nobody says that to a voice assistant. They say "my oxygen concentrator".

So this matches on equipment category, and the wording is built around that limit rather than
apologising for it afterwards. It can say there is an ongoing Class I recall affecting oxygen
concentrators from a named firm, with the reason, and that the customer should check their model
against the notice. It cannot say "your concentrator is recalled", and pretending otherwise would
either frighten somebody whose device is fine or reassure somebody whose is not. Nine of the tests
exist only to hold that line, because a false alarm lands hardest on exactly the person least able to
absorb one. Only Class I is ever volunteered inside an answer about going outside.

## Tools

Thirteen tools by default. Related actions share one tool, because tool choice gets worse as the list
grows: everything about the person is `about_me`, every change to the family list is `contact`.
With `SUDOR_SCOPE=all` the original, finer-grained tools are listed instead.

**Answers**
* `weather_check` whether right now is fine, a time for care, or better spent inside, and why. Needs no
  arguments: it uses the saved place and medicines. An active official warning is said in the same answer, and
  "stay in" is never said alone when the cooling at home is out
* `plan_my_day` the best time to go out today or tomorrow, and the hours to avoid. Given shift hours, it plans a
  shift, with the OSHA proposed 80 and 90 degree lines and acclimatization for a new worker
* `going_out_now` precautions for going out when it cannot wait, two at a time
* `warning_signs` what to do for the symptoms someone describes, in the heat or the cold. In an emergency it says
  the local emergency number first, names the nearest emergency department, and emails contacts who have agreed
* `storm_prep` the official warning where they live, turned into steps for this person: what to do first, insulin
  and injection pens, equipment that needs power, dialysis, and whether to leave
* `somewhere_to_go` open shelters near this address in the US, or the local council elsewhere, and the nearest
  emergency department
* `get_help` tells every contact who has agreed that this person needs help, or with `status: safe` that they are
  all right. Email, and a text to anyone who added their number. It cannot phone anyone or reach the emergency services
* `log_outing` records how a trip outside went, so the next answer can learn from it
* `what_can_you_do`, `tell_me_more`

**About you**
* `about_me` where they live (a city and state, a city and country, or a zip code), medicines, conditions, medical
  equipment, whether the cooling at home works, the indoor temperature they read out, whether they sleep on the top
  floor, privacy, recalls, and forgetting everything. Several at once. A saved place is not replaced without a yes,
  so "my dad is in Tucson" is never saved as the speaker's own home

**Family**
* `contact` adds, confirms or removes a family member or caregiver. With no address said, it hands back a page to
  type it on. The account holder's yes sends one invitation; nothing else is sent until that person agrees
* `share_my_day` a one-time code so a family member, or a crew lead on Orbita, can see how the day is looking,
  never why

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

### In the heat, when indoors is the danger

The usual answer on the worst days is "stay in", and it is only good advice when in is cooler than out.
Maricopa County's 2025 report on heat deaths found an air conditioner in 94 percent of the homes where somebody
died indoors, and not working in 72 percent of those; nine in ten of the people were over fifty. So Sudor asks,
once a day at most, whether the cooling is working, and remembers the answer (`src/indoor.ts`):

* **The numbers are Health Canada's.** 79F (26C) is its upper indoor limit for adults over sixty, from trials in
  which strain did not rise over eight hours at 26C and rose above it; 88F (31C) is where it says sustained
  exposure should be avoided for anybody heat-susceptible. The CDC's line that a fan stops helping above 90F is
  said to anybody whose only cooling is a fan.
* **It never pretends to measure a room.** If they read out the thermometer, that number is used for three
  hours. Otherwise the live forecast says whether the house can cool at all: a home without working cooling ends
  the day about as hot as outside, so a high of 108 and a night that only falls to 86 is said as exactly that.
* **Sleeping under the roof.** In the 2003 French heat wave, older people whose bedroom was directly under the
  roof had about four times the odds of dying (Vandentorren and others, 2006). Somebody who says they sleep on
  the top floor is told that, with the one thing to do about it: sleep lower down until it passes.

## Outside the United States

Alexa+ is sold in the United States, Canada and the UK, and in early access in Brazil, Mexico, Germany, Austria,
France, Italy, Spain, Australia and India. A place is matched in the US first when it is ambiguous ("Lyon" is Lyon,
Mississippi), and anywhere else when a country is said ("Lyon, France").

| | Medicine brand names | Official warnings | Emergency number | Recalls |
|---|---|---|---|---|
| United States | RxNorm | National Weather Service, plus HeatRisk, hurricane cones and river forecasts | 911 | FDA |
| Canada | Health Canada, 6,052 brands | WMO centre | 911 | Health Canada |
| India | 174,000 brands | NDMA SACHET (IMD, state authorities) | 112, or 108 for an ambulance | FDA, said as the US list |
| France | ANSM, 8,940 brands | MeteoAlarm | 112 | FDA, said as the US list |
| Brazil | ANVISA, 6,672 brands | INMET | 192 | FDA, said as the US list |
| Italy | AIFA, 2,625 brands | MeteoAlarm | 112 | FDA, said as the US list |
| Spain | AEMPS, asked live | MeteoAlarm | 112 | FDA, said as the US list |
| United Kingdom | NHS BSA BNF list, 5,604 brands | MeteoAlarm, matched by town | 999 | MHRA |
| Germany, Austria | generic names (no free bulk register: BfArM sells its detail, the Austrian dictionary is licensed) | MeteoAlarm | 112 | FDA, said as the US list |
| Mexico | generic names (COFEPRIS publishes a search page, not a download) | hurricane cones only | 911 | FDA, said as the US list |
| Australia | generic names | WMO centre | 000 | FDA, said as the US list |

* **Names from other countries.** A generic name is the same nearly everywhere, and the dozen that differ
  (salbutamol, paracetamol, frusemide) are mapped to the American ones (`src/brands.ts`). A name in another
  language, "furosemida", "nifedipino", "levotiroxina", is looked up in the National Library of Medicine's
  approximate match and kept only when the English name is spelled within a quarter of the word of what was said:
  without that rule, "nifédipine" came back as budipine, a different drug. Brand names are read from each
  country's own regulator; the answer always says what a brand was read as ("Amlong is amlodipine").
* **Warnings** come from each country's official service where one is published as data: MeteoAlarm for 32
  European countries, with the outlines of its 2,104 warning areas (`assets/meteoalarm-areas.json`); INMET for
  Brazil; SACHET for India; otherwise the WMO Severe Weather Information Centre, whose map server is asked which
  warnings cover the point. A failure is always "could not check", never an all-clear.
* **Language.** Amazon Translate is not available to this AWS account, and Alexa+ is itself a language model that
  answers in the customer's own language, so the server's instructions tell the host which language this person
  most likely speaks and to keep every number, medicine name and the emergency number exactly as given. The
  answers this server writes are English.
* **Somewhere to go** is the local council, the emergency number and the nearest hospital, in place of the US
  shelter list and the 211 line. **Temperatures** are said in Celsius as well.

### Data from other countries, and the terms it comes under

| Data | Source | Terms |
|---|---|---|
| Indian brand names | A-Z Medicine Dataset of India (Kaggle), via github.com/junioralive/Indian-Medicine-Dataset | CC BY-SA 4.0 |
| Canadian brand names and recalls | Health Canada Drug Product Database; Recalls and Safety Alerts open data | Open Government Licence - Canada |
| French brand names | ANSM, Base de données publique des médicaments (base-donnees-publique.medicaments.gouv.fr), as downloaded October 2026 | Free reuse with the source and date given, data unaltered |
| Brazilian brand names | ANVISA, Dados abertos de medicamentos registrados | Brazilian open data, source cited |
| Italian brand names | AIFA, Class A medicines by trade name, 30 June 2025 | AIFA open data, source cited |
| Spanish medicines | AEMPS, CIMA search service, asked live | Public service, source cited |
| UK brand names | NHS Business Services Authority, BNF code information, September 2026 | Open Government Licence v3.0 |
| UK recalls | MHRA drug and device alerts, via the GOV.UK search API | Open Government Licence v3.0 |
| European warnings | MeteoAlarm feeds | CC BY 4.0 |
| European warning areas | EMMA_ID outlines from the MIT-licensed `meteoalarm` package (github.com/NiklasJordan/meteoalarm); NUTS3 outlines from Eurostat GISCO, © EuroGeographics for the administrative boundaries | MIT; Eurostat GISCO terms |
| Brazilian warnings | INMET | Reuse with the source cited |
| Indian warnings | NDMA SACHET | Public alerting service |

The brand lists are rebuilt with `scripts/build-india-brands.py` and `scripts/build-country-brands.py`, and the
warning areas with `scripts/build-meteoalarm-areas.py`.

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

## Asking, instead of guessing

`findMedication` is an exact lookup. Anything it does not recognise is told, honestly, that it is not
in the table and might still matter. That is the right answer for a drug this genuinely does not know,
and the wrong one for a drug it knows perfectly well under a name that arrived slightly mangled.

Drug names are the worst case for speech transcription there is. They are long, they are not words,
and several in this table differ by one syllable while doing entirely different things to a body in
heat. Lisinopril blunts thirst; liraglutide does not. Being told "I don't have that in my list"
because a microphone heard one letter wrong loses advice the customer needed and had asked for.

Elicitation, new in spec 2025-11-25, closes that: when a name is one or two edits from something known,
the server asks. Levenshtein rather than a phonetic key, because the failure being corrected is a
letter-level transcription slip and phonetic matching would happily collapse names that need to stay
apart. The budget scales with length, one edit for a short name and two for a longer one, or four
letter names would match half the table.

**A medication is added because the customer confirmed the name, never because an edit distance looked
close enough.** There is a "none of these" option, and declining or an unsupported host both land back
on the honest unknown answer without ever naming the drug that was suspected. Substituting a drug
somebody did not say is the worst failure this product could have, and the tests exist to hold that
line rather than to demonstrate the feature.

## An Alexa+ stand-in

MCP add-on support is in preview and access has to be requested, so this cannot be demonstrated on a
real Echo. The demo page's answer until now was a catalogue of buttons, each hardcoded to a tool and a
set of arguments. That proves the server answers and proves nothing about the part of MCP that is hard,
because a human wrote the tool name and filled in the arguments.

The interesting step is a model reading `tools/list` cold and working out that "I just started taking
water pills" means the medication tool with a generic name it had to infer. Certification tests that
and little else: clear descriptions mapping to distinct intents, synonyms and alternate spellings in
the parameter descriptions, every example utterance working when spoken.

So `/agent` is a test of the tool descriptions, not of the tools, and it matters more here than in most
products because the descriptions carry clinical vocabulary. The gap between what somebody says and
what the table calls it is exactly what a description has to close.

The stand-in's prompt carries two rules this add-on needs and a farm one would not. Never invent a
medication, a dose, a condition or a location the customer did not say: pass their own words through
and let the server decide what they match, because it is built to ask when it is unsure and it knows
things about drug names a model should not second-guess. And if what they describe sounds like somebody
in trouble right now, confusion, fainting, hot dry skin, reach for the tool that handles symptoms
rather than the one that plans a day.

It is not Alexa, and that disclaimer travels in the response payload rather than living here. The model is
Claude Sonnet 5.5, with a daily cap of 25 calls (Haiku 4.5 answered one turn in five with a question instead of a tool in the conversation tests, so it was replaced); the server's own instructions, which tell a host what this
person has already saved (as counts, never names), are passed to it exactly as a host receives them. With no
key, or once the cap is reached, plain word rules choose the tool instead (`src/rules.ts`), as another entry in
this hackathon, Recall Check, does, and the screen says which chose. The demo page takes typed or spoken words;
hearing and speaking are the browser's own.

## Hearing it

Every sentence this server produces is written to be heard once, and here the listener is often the
reason. Somebody with multiple sclerosis deciding whether to go out. Somebody whose medication has
taken their sweating away. Somebody reading the signs of heat stroke in another person, which is the
whole argument:

> If they become confused, slur their words or faint, that can be heat stroke: call 911.

That has to land at the speed of speech, once, to somebody frightened. Whether it does is not
something a page of text can show.

`/speak` runs the same string the tool returned through Polly. Joanna, neural, chosen over the default
because a neural voice handles the drug names far better than a standard one, and "hydrochlorothiazide"
appears in real advice. For the demo and the video only; Alexa+ does its own speech, and nothing in the
MCP path synthesises audio.

Polly charges per character, so it is fenced: a content-hash cache, a 2,000 character ceiling, and
angle brackets refused outright rather than escaped, because passing caller text through as SSML would
let anyone who can reach the endpoint change the voice, insert silence, or spell text out at a
different rate and price.

## Family, privacy, and learning from a bad afternoon

**Telling someone.** An add-on cannot make an Echo speak first, so the server does it. When warning
signs describe heat stroke, the answer says to call 911 first, then confirmed emergency contacts are
emailed. In the evening where the person lives, if tomorrow stays in the risky range for them all
day, confirmed contacts get one email for that day. Contacts are staged and only emailed after the
person confirms. Email goes through Amazon SES when `SUDOR_EMAIL_FROM` is set to a verified sender;
until then every attempt is still logged to `data/outbox.jsonl` and the spoken answer says it
cannot email yet, rather than claiming it did. The log holds a short hash of the address and no
subject line. One address is sent at most eight emails a day, and at most three emergency emails an
hour, because a contact is confirmed by the person and not by whoever owns the address. The
stay-inside email never names a condition or a medicine.

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

**Disasters, for one person.** When any official warning is in force where somebody lives, `storm_prep` leads with
it and its first step (`src/hazard.ts`): a hurricane, flood, tornado, winter storm, wildfire smoke, extreme heat or
cold, high wind or a tsunami. "Go now to the lowest floor" comes before anything about a pharmacy. The general steps
are Ready.gov's and the CDC's, shortened to be said aloud; there is no feed of what to do, only of what is coming,
and what is coming is always read live. Then what is particular to them: the equipment they said they rely on
("your oxygen concentrator needs power: charge every battery, tell your electricity company there is medical
equipment in the house"), insulin in a cooler if they leave, dialysis, no shovelling with a heart condition. Smoke
comes with the live air quality index and the EPA's name for its band. The answer ends by offering to tell the
family they are safe, and the family is emailed once, with nothing about health, when a warning starts where they
live.

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

## The Agent Skill

The tools say what each one does. They do not say how to carry somebody through a bad day: which tool answers
which sentence, when to follow the next step without asking and when to wait for a yes, and how to say an answer
that leads with 911. That is written down once, as an [Agent Skill](https://agentskills.io), in
`skills/sudor-heat-safety`.

| File | What it holds |
|---|---|
| `SKILL.md` | When to use Sudor, the sentence-to-tool table, how to follow a chain, how to say the answer, what to do when someone is unwell, privacy, and what it does not cover |
| `references/tools.md` | Every tool with its arguments, written from the server's own tool list by `scripts/skill-tools.mjs` |
| `references/chains.md` | Each next step an answer can name, and the condition the server applies before naming it |
| `scripts/connect.mjs` | Connects to a Sudor server and lists its tools. It reads only, and needs nothing but Node |

There are two ways to get it. Copy the folder into an assistant's skills location, as with any Agent Skill. Or
read it from the server: every file is also an MCP resource at `skill://sudor-heat-safety/...`, listed with the
skill's description and a SHA-256 of its text, so an assistant that has only connected to the server can load
the skill from the same connection it calls the tools on. The addresses follow the Skills over MCP draft
(SEP-2640). Only resources are used, which every host already reads; the draft's own methods are not final and
are not implemented.

```bash
node skills/sudor-heat-safety/scripts/connect.mjs                         # a server on this machine
node skills/sudor-heat-safety/scripts/connect.mjs https://host/mcp --demo  # the public demo
```

A skill that drifts from its server is worse than none, so `test-skill.mjs` holds the two together: every tool
the skill names exists, every tool the server offers is in the skill, the tool reference matches the live tool
list exactly, each chain in it is one the code really names, and the example of `flow` is what the server
returns. The format is checked against the specification and by its reference validator, `skills-ref`.

## A Strands agent that follows the chain

Every answer names the step that follows. `strands/agent.mjs` is the agent that follows them, built on the
[Strands Agents SDK](https://strandsagents.com), AWS's open agent framework. It lives in its own folder with
its own dependencies, so the server's are untouched.

| What it does | How |
|---|---|
| Connects to Sudor | Strands' MCP client, over Streamable HTTP |
| Learns how to use it | Reads the Agent Skill from the same connection (`skill://sudor-heat-safety/SKILL.md`) and uses it, with the server's instructions, as its system prompt. Nothing is copied into the agent |
| Sees the chain | Each tool is wrapped as a Strands tool that returns `say`, `nextAction` and `flow`. A plain MCP adapter passes on only the text, and the next step is in the structured half |
| Asks before it saves or sends | A tool the server does not mark read-only is refused unless the person has said yes (`--yes`). The rule is in code, not in the prompt |
| Has a ceiling | At most six tool calls a run and 700 tokens a reply, on the smallest current Claude model by default |

```bash
cd strands && npm install

node agent.mjs --plan --url https://host/mcp --demo     # no model, no key, no cost
ANTHROPIC_API_KEY=... node agent.mjs "Is it safe for me to go out?" --url https://host/mcp --demo
```

`--plan` swaps Claude for a scripted model that starts at one tool and calls whatever `nextAction` each answer
names. It runs through the same Strands agent loop, the same wrapped tools and the same guard, which is how the
chain is tested for nothing: `node strands/test.mjs` runs the real tools in process on a seeded 110 degree day and checks
that one request runs from the weather, to the safest hour, to going out anyway and the rest of the precautions, that nothing is saved without a yes, and that the cap holds. 28 checks, no key, no network.

The path through Claude uses Strands' Anthropic provider and needs a key. It costs a few cents a run, so it is
not part of the automated checks.

## On a screen, with the family's phone beside it

`/echo.html` is a stand-in for an Echo Show. Down the page are the lines somebody might say; each is a real tool
call with real arguments (`web/echo-scenes.json`), and a test calls every one. Under them, **Or say anything**
takes typed or spoken words (press Speak, in Chrome or Edge) and sends them to the stand-in, which picks the tool;
the screen says which tool was chosen and whether a model or the word rules chose it.

Beside the screen is the phone of the person who gets told. The public demo never sends email, so the message a
contact would have been sent is kept, word for word, against that visitor's own sandbox id and shown there
(`/demo/phone`). The buttons on it post to the same pages a link in a real email opens: pressing yes is the real
agreement, and pressing "I'm on my way" is the real answer, which the screen says the next time it speaks.

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

`npm test` runs everything, 2,272 checks. It is also what CI runs on every push, on Node 20 and 22,
with the live suite in its own job so an outage at a weather service is never mistaken for a
regression here.

```bash
npm run test:unit           # 1,974 checks, no live data
npm run test:live           # 298 checks, against a running server and the real forecast

node test.mjs               # heat index formula, categories, medications, how the lines read aloud
node test-personal.mjs      # conditions, an age said aloud, sensitivity, planning, precautions, first aid
node test-actions.mjs       # removing, privacy, learned limits, contacts, emails, repeats, forgetting, retention
node test-panel.mjs         # the MCP Apps handshake against a simulated host
node test-skill.mjs         # the Agent Skill: its format, every tool and chain it names, and reading it over MCP
node test-gaps.mjs          # a home too hot, asking afterwards, carers, how sure, more cities, more outages, the counts
node test-conversations.mjs # whole conversations in the patterns real users were recorded in, with a scripted host
node test-readme.mjs        # every count, file, setting and result this README states, against the code
node strands/test.mjs       # the Strands agent, with a scripted model: needs `npm install` in strands/ first
node test-auth.mjs          # OAuth 2.1 with PKCE against a running server
node test-static-client.mjs # the account linking shape Alexa+ actually uses
node test-cold.mjs          # wind chill against the NWS chart, frostbite times, hypothermia first aid
node test-recalls.mjs       # FDA recalls, severity, privacy, and never a false all clear
node test-warnings.mjs      # official alerts, the personal half, and storm prep by medicine
node test-spaceweather.mjs  # asking Orbita over MCP, what crosses the wire, the base rate, silence on failure
node test-shelters.mjs      # open shelters, distances, what the feed does not say, and 211
node test-web.mjs           # the demo page, every request on it, one profile per visitor, older hosts
node test-contract.mjs      # every listed tool invoked for real, on an empty profile and a half set
                            #       up one, with junk arguments, annotations checked, and every answer read
                            #       back for sentences that would stumble out loud
node test-latency.mjs       # the voice budget, measured per tool, written to LATENCY.md
node probe.mjs              # end to end against live Open-Meteo and geocoding
```

Alexa+ account linking is not the generic MCP OAuth shape: Amazon's docs state that it "supports
only the Authorization Code Grant" and that "Dynamic Client Registration isn't supported." Pick
your own `client_id`, run `alexa-ai configure-account-linking --client-id <id>`, and set the
redirect URIs the CLI hands back. Once `SUDOR_CLIENT_ID` is set, this server's own registration endpoint is
closed, so nobody else can register a client that calls itself Alexa+:

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

### Sealing, linking and spend limits

* **Encrypted at rest.** With `SUDOR_DATA_KEY` set, the people file and the token file are sealed with
  AES-256-GCM, with a key id and the purpose bound in as associated data. These files hold medicines and
  conditions. The key lives in SSM Parameter Store. Losing it is losing the data, and there is no recovery.
  `SUDOR_DATA_KEY_PREVIOUS` supports rotation. A wrong key is treated as different from a corrupt file: the
  server refuses to start rather than quarantine data it could not open. `SUDOR_REQUIRE_ENCRYPTION=on`
  makes a missing key fatal.
* **Linking needs a passphrase.** The first person to present a name claims it (trust on first use, so a
  name can be squatted before its owner arrives; accounts that predate passphrases are claimed by the first
  presenter). Passphrases are hashed with scrypt at the OWASP parameters, wrong guesses lock out, and the
  failure messages do not reveal whether a name exists.
* **Tokens are hashed and persisted.** Access and refresh tokens are stored as SHA-256 digests, so a deploy
  does not sign anyone out and a stolen file holds no usable token. Refresh tokens rotate, and replaying a
  spent one revokes the whole family (RFC 9700).
* **The demo page has its own door.** Ids of the form `demo:<128-bit hex>` live in a separate namespace
  that cannot reach a linked account. `SUDOR_DEMO=off` closes it. Email, including family emergency alerts,
  is disabled for sandbox callers, so the endpoint cannot be used to send mail to a stranger.
* **Spend and size limits.** `/agent` and `/speak` have a per-caller bucket and a daily cap, sandbox callers
  are keyed by address so rotating ids does not help, and profiles, contacts, followed places and timers
  have ceilings. These counters are in memory and reset when the service restarts. Feed polling backs off
  exponentially with jitter when an upstream fails.
* **Behind API Gateway.** No proxy is trusted unless told to: with `SUDOR_TRUST_PROXY` unset, `X-Forwarded-For`
  is ignored, so an invented address does not buy a fresh allowance. `SUDOR_TRUST_PROXY=1` counts one hop, and the origin secret is armed only after
  the gateway sends it. See `deploy/README.md` for the order.

## Asking for help, and where to go

Three things were added for the day the weather is most dangerous, which is the day the power is out.

* **`get_help`.** "Get help, the power is out and I'm cold." Every confirmed contact is emailed at once with what
  was said, roughly where the person is, the nearest open shelter and the nearest emergency department, each with a
  link that opens directions. Nothing about a medicine or a condition is in it. The spoken answer says who is being
  emailed and then says, every time, that the add-on cannot phone anyone and cannot reach 911. It never says help
  was called. Three an hour per contact, counted apart from ordinary mail, and nothing from the public demo.
* **The nearest emergency department.** Named in `get_help`, and in `warning_signs` after the first aid whenever the
  answer is to get medical help. Two sources are combined (`src/care.ts`). Amazon Location Service gives the
  position, the phone number and so the distance, called with the role the server already runs under. Medicare's
  Hospital General Information list gives the one fact no map has, which hospitals report emergency services.
  "Nearest" is said only when a distance was measured, and where the map cannot be reached a hospital in the same
  town is named from the Medicare list. Looked up in the background when a place is set, never inside a tool call.
* **Shelters and storm preparation are part of the default tool set again.** `somewhere_to_go` now ends by offering
  to tell the family, and `storm_prep` is where a geomagnetic storm from Orbita is turned into what to do about
  medicines that need a fridge or a socket.

What is not there: a text message or a phone call. Both need a registered sending number, and neither has been set
up or tested, so neither is claimed. The role the server runs under needs `geo-places:SearchNearby`.

## A named place, the days ahead, and the power

Five things added from the 2026 research and the heat plans cities published this year.

* **A cooling centre by name.** "Call 211" is true and is not a place. Cities and counties that run cooling
  centres publish them as open map layers, and twenty-three of those are read whole on a timer (`src/cooling.ts`), so
  nobody's address goes anywhere: "The nearest cooling centre open today is Burton Barr Library, at 1221 N Central
  Ave, about 1 mile away, from 9 am to 8 pm." Left out: water-only hydration stations, anything closed today or out
  of season, and outdoor spray pads, which are cooling and are also in the sun. A centre kept for older adults is
  offered only to somebody who has said they are one. "Open today" is said only when the list gives today's hours;
  otherwise its hours are read out. A list that could not be read is "I could not check".
* **Hot days in a row.** A study of older adults in New York City (JAMA Network Open, March 2026) found the risk
  of heat stroke and death rising sharply once the heat index reached 90 for two days running, five degrees below
  where the city declares a heat emergency. So a run of two or more such days is said the day before it starts, to
  older adults and to anyone whose medicines or conditions make heat riskier: "Tomorrow starts 3 days in a row
  that feel like 90 or more, up to 101. For people over 65 the risk climbs on the second hot day, below the level
  cities warn at" (`src/streak.ts`).
* **The power, in California.** When the state's outage map shows the power out at the person's address, the storm
  and somewhere-to-go answers open with it: the utility, whether it is planned or a safety shutoff, and when it
  is expected back (`src/outages.ts`). The map is read whole and matched here.
* **Fire weather and a powered medical device.** On a Red Flag day, somebody with an oxygen concentrator hears that
  the power company may switch the power off on purpose, and to ask to be put on its medical list, whose customers
  are warned first (`src/hazard.ts`).
* **An Alexa routine.** Many Echo devices have a temperature sensor, and a routine can start when a room passes a
  temperature. Somebody who says their cooling is a fan, broken or missing is told to ask Alexa for one at 79
  degrees, Health Canada's upper indoor limit for older adults. It is a suggestion: an add-on cannot create a
  routine.

| Data | Source | Terms |
|---|---|---|
| Phoenix area cooling and respite centres | Maricopa Association of Governments, Heat Relief Network | Public open data |
| New York City cooling centres | NYC Emergency Management | NYC open data |
| New York State cooling centres | New York State Department of Health | Public open data |
| Washington DC cooling centres | DC Homeland Security and Emergency Management Agency | Public open data |
| Houston area cooling centres | Harris County Office of Homeland Security and Emergency Management | Public open data |
| Riverside County Cool Centers | Riverside County | Public open data |
| Los Angeles activated centres | City of Los Angeles | Public open data |
| California power outages | California Governor's Office of Emergency Services | Public open data |
| Philadelphia cooling sites | City of Philadelphia | Public open data |
| San Diego County Cool Zones | County of San Diego Health and Human Services Agency | Public open data |
| Maryland cooling centres | Maryland Department of Health | Public open data |
| San Antonio places to stay cool | City of San Antonio | Public open data |
| Columbus cooling centres | City of Columbus | Public open data |
| Cleveland area cooling centres | Cuyahoga County Office of Emergency Management | Public open data |
| Rhode Island cooling centres | State of Rhode Island | Public open data |
| Toronto cooling centres | Toronto Public Health | Public open data |
| British Columbia public cooling spaces | Province of British Columbia, Emergency Management and Climate Readiness | Public open data |
| Duke Energy power outages | Duke Energy, published outage areas | Public open data |
| BC Hydro power outages | BC Hydro, published outage areas | Public open data |

## What the 2026 research said was still missing

A sweep of this year's heat deaths, trials and city plans found six gaps. Each is closed here, and each is tested
in `test-gaps.mjs`.

| Gap | What the evidence says | What Sudor does now |
|---|---|---|
| **The home is where people die** | Maryland's 2026 season: 61 heat deaths, 29 indoors. Louisiana 2026: about six in ten of the dead were found at home. Japan's environment ministry spent the summer testing an alert that tells the family when an older person's home gets too hot | When what the person has said adds up to a home too hot to stay in (a reading of 88 or more, or no working cooling on a day that reaches 88 with a night that stays above 79), the contacts who agreed to hear about bad days are emailed once that day, with nothing about health in it. A reading said aloud does it at once, and the answer says who is being told (`checkHotHome` in `src/alerts.ts`). Japan's pilot also switches the air conditioner on; an add-on cannot, so when a home whose cooling works reads 79 or more, the answer says to turn it on and set it below 79, gives the words that make Alexa do it ("Alexa, turn on the air conditioner"), and carries the same request as `homeControl` for a host that can offer to do it. It is never done on the person's behalf |
| **Being told is not acting** | In the Australian trial of a home warning system for older adults, preparedness rose and the use of cooling did not | When an answer has sent somebody out of a home that is too hot, the next thing they ask at least half an hour later begins, once, with "If you are still there, want me to find somewhere cool now?", and names somewhere to go as the next step (`src/attention.ts`) |
| **Carers do not link heat to caring** | Austrian research with family carers and live-in care workers found exactly that | A family member checking on somebody on a risky day hears what to do, not only a status: the home first if it is too hot, ring or call round, check the room is under 79, make sure they drink, and when to call 911. Never a medicine or a condition, and a private profile keeps even the home out of it |
| **Not every warning is equally sure** | Anticholinergics raise core temperature in randomised trials. Diuretics, antipsychotics and beta blockers rest on studies of admissions and deaths. GLP-1 and SGLT2 drugs rest on how they work | Every medicine class carries how strong its evidence is (`evidenceFor` in `src/meds.ts`), and a warning that rests on how a drug works says so: "take it as a precaution" |
| **Seven cities is not many** | Cities and counties publish cooling centres as open map layers, and many more do than were read | Twenty-three lists now, from Philadelphia to British Columbia, outage areas from Duke Energy and BC Hydro as well as California, and county outage counts for Maryland, Pennsylvania, Ohio and Alliant Energy's Iowa and Wisconsin |
| **Nobody measures whether warnings work** | Reviews of heat warning systems find few that measure anything past sending the warning. Quebec's public health institute sets out the chain: knowledge, intention, behaviour, health | Sudor counts, per day, the links it can see: warned, sent away, asked afterwards, went looking for somewhere, family told, carer given steps, outings fine and unwell. Counts only, with demo visitors kept apart. `GET /impact` returns the totals and the share of people sent away who then looked for somewhere to go (`src/impact.ts`) |

Sources: [Maryland 2026 season](https://marylandmatters.org/?p=101456),
[Louisiana 2026](https://content.wbrz.com/news/louisiana-heat-has-killed-8-people-in-2026-ldh-says-see-how-to-protect-yourself-and-neighbors),
[Japan's 2026 pilot](https://english.adnkronos.com/2026/08/13/japan-testing-new-tech-to-prevent-heatstroke-among-elderly/),
[the Australian home warning trial](https://pmc.ncbi.nlm.nih.gov/articles/PMC11840092/),
[IMC Krems on family carers](https://www.imc.ac.at/en/about-us/media-press/news/detail/heatwaves-in-family-care-rising-temperatures-rising-challenges/),
[the medications meta-analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC11541675/),
[INSPQ evaluation guide](https://www.inspq.qc.ca/en/publications/1794),
[review of heat health warning systems](https://www.preventionweb.net/quick/99463).

## What the October 2026 sweep changed

A second pass, checked against the papers themselves rather than their summaries, and each tested in
`test-research.mjs` and `test-heatwaves.mjs`.

| Gap | What the evidence says | What Sudor does now |
|---|---|---|
| **The thresholds were an approximation** | Wolf and others (2023) took 49 healthy adults aged 71 on average into a chamber and found the heat and humidity past which their core temperature could no longer settle: at 34 C above 62 percent humidity doing light everyday things, at 38 C above 46, at 40 C above 34, and hotter in dry air | That table is in `src/physiology.ts`. For someone 65 or over, or whose medicine blocks sweating, an hour past it is "stay in", and the answer says what was measured: "past the heat in which healthy people in their seventies could no longer keep their body temperature from climbing", with "lower still" when a medicine blocks sweating. Below 34 C, where nobody was tested, it says nothing. Not said under privacy, because it gives away an age |
| **Fan advice was one number** | A fan helped older hearts in humid heat (38 C, 60 percent) and tripled their strain in very hot dry heat (45 C, 15 percent), where wetting the skin helped (NEJM, 2024). At 36 C a fan did not lower the peak core temperature of people aged 65 to 85 at all (JAMA, 2024) | Above 90 indoors: in very hot dry air, do not use a fan, wet the skin; for someone who sweats less, above 95 a fan is never enough on its own; otherwise a fan helps more with the skin wet. Wetting the skin is said to anybody without working cooling. The 104 F and 30 percent line between dry and humid is this project's, set between the two conditions tested |
| **Dementia was missing** | In about 244,000 people in Germany over fifteen years, heat raised the chance of death only for those with dementia; in more than three million Medicare admissions, the odds rose after one day of extreme heat and more after four. The German authors recommend alerts that reach the carer | Dementia is a condition, in the extremely sensitive group, with a plan that does not wait for the person to feel hot or thirsty, and a step for the family that never names it: offer drinks rather than wait to be asked, and feel the room yourself |
| **Babies and young children were missing** | The CDC: they rely on the adults with them; never leave them in a parked car, which can warm by nearly 20 F in ten minutes | "I have a toddler" plans the day at the child's sensitivity, with the CDC's own steps, and fewer wet nappies or diapers as the sign to watch |
| **A working air conditioner left off** | Maricopa County, 2024: among people who died indoors, 88 percent had an air conditioner and 70 percent of those did not work. About 19 states and DC bar shutting the power off in extreme heat (NCLC, July 2026) | "I can't afford to run it" is its own cooling state, judged as no cooling, and in the United States the answer gives the LIHEAP referral line and that protection, and says to ask the utility. No state's own rule is named, because the list could not be confirmed |
| **Never checked against a real disaster** | The Portland heat dome: of Multnomah County's 72 heat deaths in 2021, 78 percent were 60 or older, 71 percent lived alone, 94 percent died at home, and almost none had working cooling. Phoenix, July 2023: a record 645 deaths that year | `evals/heatwaves.mjs` runs that person through the archived weather of those days. Phoenix, all four days: "your home is too hot to stay in" and the family told. Portland's deadliest day, 28 June, 115 outside with a forecast night of 66, was only a warning on the first run, because the rule waited for a hot night; the measured limit now makes it the home too hot to stay in, and in that dry heat says to wet the skin rather than use a fan. Every day with working cooling says nothing about the home |

What was looked at and not changed: nitroglycerin tablets were left out of the medicines heat spoils, because a
stability study found them holding potency at 40 C in their own container. Adding up several medicines that each
block sweating has no heat specific evidence behind it yet. The UK's heat-health alerts have no documented feed to
read, so the UK still gets the Met Office's warnings through MeteoAlarm.

Sources: [Wolf et al. 2023](https://doi.org/10.1038/s43247-023-01159-9),
[Chaseling et al., NEJM 2024](https://doi.org/10.1056/NEJMc2407812),
[O'Connor et al., JAMA 2024](https://jamanetwork.com/journals/jama/fullarticle/2825091),
[review of electric fans, Lancet Planetary Health](https://doi.org/10.1016/S2542-5196(24)00030-5),
[dementia and temperature, Germany](https://doi.org/10.1093/gerona/glae292),
[dementia and heat, Medicare](https://jamanetwork.com/journals/jamainternalmedicine/article-abstract/2829472),
[CDC, infants and children](https://www.cdc.gov/heat-health/risk-factors/infants-and-children.html),
[Maricopa County 2024](https://www.maricopa.gov/CivicAlerts.aspx?AID=3222),
[NCLC, July 2026](https://www.nclc.org/report-calls-for-ban-on-utility-disconnections-during-extreme-heat/),
[LIHEAP referral line](https://liheapch.ncat.org/node/1516),
[Multnomah County 2021](https://multco.us/news/2021-heat-killed-72-people-multnomah-county-most-were-older-lived-alone-had-no-ac).

## Who agrees to be emailed

A contact used to be confirmed by the account holder alone. Now the account holder's yes sends one invitation, and
nothing else goes to that address until the person who owns it opens the link and presses yes (`src/consent.ts`). The
link opens a page with a button and does not accept on being opened, because mail scanners open every link. Only a
hash of the invitation is stored. Every email after that ends with a link that stops them. One invitation a day per
address, from any account, and none from the public demo.

Two more corrections in the same pass. A question about the signs ("is confusion a sign of heat stroke?") still gets
the 911 advice, and no longer emails the family that heat stroke was described. And wrong passphrases are counted per
address, so five wrong guesses lock out the address that made them and not the person whose name was typed.

## The answer comes back

The help email carries a link. The family member presses "I'm on my way" or "Ask them to ring me", and the next
thing the person hears from Sudor, whatever they ask, starts with it: "Priya answered: they are on the way." The link
works once, lasts six hours, and only its hash is stored. It does not replace ringing them, and the page says so.

## People who work outside

`plan_my_day` takes a shift (`shiftStart`, `shiftEnd`) for somebody who cannot choose their hours. It says when the
heat index passes 80 and 90, the two lines in the workplace heat rule OSHA proposed in 2024, when to take the
fifteen minute breaks, and, where it is earlier, the hour that is risky for this person given what they take.
The rule is described as proposed, because that is what it is.

## One decision for the machines and the people

Of outdoor workers who died of heat between 2011 and 2016, 79 percent were in their first two weeks on the job or just
back from time away. So somebody who says they have started outdoor work, or come back to it, is remembered as that,
dated to the day they said it, and `plan_my_day` rations the heat on the schedule NIOSH recommends: a fifth of a usual
day on day one and a fifth more each day for somebody new; half, then 60 and 80 percent, for somebody returning.
"This is day 2 of getting used to the heat, so no more than 4 hours of it today: done by 11 am."

The same person can share their working day with a crew. `share_my_day` gives a one-time code; the farm's Orbita
server exchanges it for a link and asks `check_on` over MCP. What goes back is what a foreman needs: how hot the shift
gets, when it turns risky for this person, and how many hours of heat they should do. Never a medicine, a condition
or a reason, and the link dies the moment they stop sharing. Orbita then says it in the same breath as the job:
"Clear for planting. Dana is on day 2 in the heat: 4 hours of it today, done by 11 am."

## How the conversation is designed

* **Short answers.** A read-only answer is spoken as its first three sentences, led by the answer for this person
  ("For you, it is better to stay in right now"). The rest is returned as `more` in the structured result and spoken
  when the customer says "tell me more" (`tell_me_more`). The line about not stopping a medicine is always said. An
  answer that mentions 911, a write, and a tool that pages its own steps are never shortened. See `src/brief.ts`.
* **Plain words, one message.** The heat is said as "it feels like 108 degrees", and the weather service's level
  only when it is danger, so "stay in" is never followed by "caution". A medicine is named ("your metoprolol blocks
  your sweating") and the line about it is "Keep taking it unless your doctor says otherwise."
* **As long as the danger.** A wind advisory is its headline and one step, 27 words; a hurricane warning is read in
  full. Saving several details is one sentence ("Got it: furosemide, metoprolol and heart disease"), 13 words where
  reading each back with its advice took 81. "I have 3 more, if you want them" comes last, after the 911 line.
* **One story by default.** The default tool set is one person, the weather outside, what they take, and the day the
  power goes out. Shovelling, the full list of official warnings, sunburn and recalls are published only with
  `SUDOR_SCOPE=all`.
* **Asked twice, answered differently.** The same question inside a minute and a half, with the same answer, gets the
  verdict alone and what to ask next, not the same sixty words. An answer that mentions 911 is said in full every time.
* **Said until it is heard.** Once a day has been planned as a stay-inside day, the next answers start by saying so,
  three times at most, until the person says "got it". Never in front of an emergency, a symptom or a call for help. See `src/attention.ts`.
* **An address is typed, not spelled.** "Tell my daughter Priya" with no address hands back a page to type it on. A
  host that supports MCP's URL-mode elicitation is sent the page directly; any other gets the link in the answer's
  data. The page stages the contact and nothing is sent until the person says yes. See `src/consent.ts`.
* **Answers hand back a handle.** Adding a contact returns its id and the exact next call (`nextAction`), and the
  next call accepts the id, so a follow-up does not depend on a name being heard the same way twice.
* **An answer ends on the next step.** A risky hour ends with "Want me to find the safest time to go out today?".
* **One request, several steps.** A bad day is not one question. Every answer carries the chain it is on
  (`flow` in the structured result, `src/flow.ts`): what has just been done, the step that follows, and the ones
  after. A host can run them from one request or offer them one at a time.

  | It starts with | and runs on to |
  |---|---|
  | "Is it safe to go out?" on a dangerous day | the safest hour, then how to go out anyway, then the warning signs |
  | the same day in a home with no working cooling | "Want me to find somewhere cool you can go?", then the named cooling centre, then telling the family |
  | "The power is out", in California | the outage at the address, what it means for medicines and equipment, somewhere with power, then telling the family |
  | "Get help", with nowhere looked for yet | somewhere to go |
  | adding a medicine | what it changes about today |

  A fine day names no next step and starts no chain. Nothing is called on the person's behalf: the chain says what
  comes next, and each tool still decides from their own state whether its step applies.
* **A card that fits the task.** The day strip (`ui/window.html`) is for the weather. The profile, a contact being
  confirmed, a sharing code and the "Call 911 now" card use `ui/card.html`. The profile card shows counts, not names.
* **A second person.** The person asks for a one-time code (`share_my_day`); a family member joins with it from their
  own account and can ask how the day is looking (`check_on`). They hear whether it is a fine day, a day to take care
  or a day to stay in, and never a medicine, a condition or a reason.

## Is the answer worth having

[BACKTEST.md](BACKTEST.md) replays the measured hourly weather for July 2026 in six American cities through the same
code the server runs, for two people: one with nothing registered, and one on metoprolol and furosemide with heart
disease. The two answers differ in 36 to 86 percent of waking hours. In Tampa the second person had 7 days of 31 with no
fine hour to be outside, and the first had none; in Phoenix it was 24 days against 5. It counts how often the answers
differ, from heat alone. It does not show that anybody was harmed or protected. `node evals/backtest.mjs` regenerates it.

## Evaluating tool selection

The golden set and the saved baseline were run with the full tool set (`SCOPE=all`) and before the sharing,
"tell me more", `get_help` and shift-planning additions. The new sentences for those are checked against the tool
list and have not been run against a model, so the routing figures below do not cover them. The model in that run
was Claude Opus 5.5 standing in for Alexa+ (the live demo now uses Sonnet 5.5): it shows the descriptions work for that model, and nothing about the
one Alexa+ uses.

`npm test` shows the server gives the right answer once a tool is chosen. It cannot show that a host would
choose that tool from what a person said, which is what Amazon's certification list tests, so there is a
separate golden eval: 74 spoken sentences, 15 of them expecting no tool at all, each with the tool and
arguments a correct host should pick. It covers plain requests, speech-recognition noise ("north forty"),
missing information, indirect phrasing, out-of-scope requests and prompt injection.

```sh
SUDOR_ANTHROPIC_KEY=... npm run eval                # 3 trials per sentence
npm run eval -- --trials 5 --save-baseline     # keep this run as the baseline
```

It reads the server's real `tools/list`, asks a model to choose, scores the choice, and then calls the chosen
tool if it is read-only to check the extracted arguments are accepted. Routing, declining and arguments have
separate floors, because a blended number would let a host that always reaches for a tool look fine. Every
sentence runs several times and is reported as stable, flaky or never right, with pass^k (the chance that all
k trials succeed), because a sample that works two times in three looks the same as one that works every
time in a single pass. A sentence that was stable at the saved baseline and is not now fails the run.

It costs one model call per sentence per trial, so it is not part of `npm test`. `npm run eval -- --preflight` asks the API to count the tokens of the real request, which is free, proves the request is accepted, and prints what a full run would cost; the tool list is cached across calls, which cuts the input bill by about nine tenths, and `--budget <dollars>` stops a run that reaches its limit rather than finishing it. What needs no model is: the
golden file is checked against the live tool list (a renamed tool, an argument that no longer exists or an
enum value nobody can pass fails the build), and the scorer and the runner are tested against a fake host
that is deliberately flaky, over-eager or sends bad arguments. Live runs on Opus 5.5: on 1 October, 3 trials, all sentences stable, routing, declining and arguments all 100%,
every chosen read-only call answered ($0.95). On 14 October, after ten sentences for the new features, 1 trial: tool
choice 96.8% of 95, arguments 100% ($0.49). Of the three misses, "call an ambulance" chose `get_help` (which says it
cannot phone and to call 911) and "I think I overdid it out there" chose the warning signs, both now accepted with the
reason written in the golden file; "is the power out around here" chose nothing, and the storm tool's description now
says it answers that, after which it chose `storm_prep` three times in three. Read that with care: the first live runs missed several sentences, and the
fixes were tool descriptions plus a few golden sentences that were not fair single-turn tests (a required value only
the customer knows, so asking back is correct), so 100% is a regression baseline and not a blind score. A golden set is also fixed, so it cannot notice a failure it does not contain, and cases should be
added from real misses.

## Performance

Alexa+ allows roughly 500 ms for a full round trip. Measured against live data on 12 September
2026: every tool answered in 3 to 8 ms, and the slowest request in the whole probe, setting a
location by voice, took about 50 ms including starting its background lookup. On 13 September, with
all seventeen tools it had then, the contact, privacy and outing tools answered in 4 to 7 ms. Emails are sent
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

## Who this is actually for

It reads like a consumer app and the buyer is probably not a consumer.

The mortality is concentrated in one group. In Louisiana this year, seven of eight
confirmed heat deaths were people aged 65 or older, and older adults together with
young children account for nearly all of them. The CDC names adults 65 and over,
pregnant people and people with chronic conditions as more prone to heat illness, and
that is the population this table was built around.

The people being told to prepare are agencies. Home and community based services
providers are being advised to anticipate an increase in heat related illness among
vulnerable clients, and that medication regimens may need adjusting and self
monitoring is critical. That is a coordinator with a caseload, not an individual with
an Echo, and it is the shape of deployment this add-on actually fits: one server, many
people, each with their own medicines and their own address, already separated by
subject in the store.

The same argument covers an employer. OSHA's guidance on outdoor work is rest breaks
in shade or air conditioning, and the proposed federal heat rule triggers on heat index
or WBGT, which is the pair of numbers this server already computes.

None of that changes a line of code. It changes who the README is addressed to, and
the honest answer is that a single person is the demo and an agency is the product.

## It runs in more than Alexa+

MCP is client agnostic, and this server is remote and reachable over HTTPS, which is the
shape every compliant host accepts. It works today in Claude Desktop, Claude Code,
ChatGPT in developer mode, Cursor, VS Code with Copilot, Windsurf, Cline, Zed and
Replit, with nothing to build for any of them. ChatGPT matters here because it takes
only remote HTTPS servers and not the local stdio kind.

```json
{
  "mcpServers": {
    "sudor": {
      "type": "streamable-http",
      "url": "https://2f2opzcjui.execute-api.us-east-1.amazonaws.com/mcp"
    }
  }
}
```

Cursor has a soft ceiling of roughly 40 active tools across all connected servers, and
past it the agent quietly loses access to some. This publishes 18 and Orbita 15, so the
pair is 33 before anything else is connected. On a host with a ceiling, connect one.

## Honest limitations

* The one level offset between sensitivity groups follows HeatRisk's own grouping, applied to the NWS
  heat index categories. That is an approximation, not a clinical threshold for any one person. For people 65 and
  over, and anyone whose medicine blocks sweating, the chamber limit measured by Wolf and others (2023) sits beside
  it; that was measured in healthy older adults, so it is a floor for this customer, not their own limit.
* **Outside the United States** the weather, warnings, emergency number and hospitals are real, but the heat
  thresholds are American ones (the NWS heat index, OSHA's proposed lines), and warnings come from the server behind
  the WMO's public map, which is not a published API and could change. A failure there is "could not check", never an
  all-clear.
* The nearest emergency department is the nearest general hospital that Medicare lists as having emergency
  services. It is not a promise that it is open or right for the problem. The first live check in Anchorage named a
  psychiatric hospital; psychiatric, children's and veterans' hospitals are now left out.
* Email is real but the SES account is in its sandbox until Amazon approves production access, so only verified
  addresses receive it. A contact has to agree before they are sent anything but the invitation.
* Seventeen conditions, and medicines from two sources: 133 of the 286 most prescribed ingredients are recognised
  (`node evals/coverage.mjs`, 14 October 2026). Seventy-one are in Sudor's own table: the fifty-seven drawn from the
  CDC's clinical guidance on heat and medicines, and fourteen added in October from the CDC's classes and FDA labels
  (first-generation antihistamines, two antispasmodics, cyclobenzaprine, the alpha blockers, clonidine, hydralazine
  and amiodarone), each marked with how strong its evidence is. Any other name is looked up in RxNorm, the National Library of Medicine's drug vocabulary,
  which gives the ingredient and its ATC class; the class is then read against the same CDC guidance, and the answer
  says it rests on the class (`src/rxclass.ts`). Classes that mix drugs with different effects are left
  unclassified on purpose, and a combination product such as Adderall is not classified. Not a clinical database.
* **Which parts update themselves and which do not.** Drug names and classes come live from the National Library of
  Medicine, and each medicine's current FDA label is read live for an explicit heat warning (`src/labels.ts`), so a
  new drug or a new label warning is picked up without a code change. The CDC's own list is a web page with no data
  feed, and it refuses automated readers, so the 57 named medicines and the class table are a snapshot of it that
  somebody has to re-read when the CDC revises it. The label reader is deliberately narrow: it will miss a warning
  worded in a way it does not expect, and a label that says nothing is never taken as safe. Anything unrecognised is said to be
  unrecognised, never guessed. Two whole classes were missing until recently, which is the honest
  measure of how incomplete a hand-built table can be while looking finished.
* The fluid-loss mechanism is a class-level statement, not a dose-level one. A GLP-1 at a starting
  dose that causes no nausea is not losing anybody fluid, and the literature is clear that the
  gastrointestinal effects are dose related and ease with gradual titration. This does not know
  somebody's dose, so it says what the class can do and leaves the rest to their pharmacist.
* It is not a doctor and not medical advice. The warning signs follow NWS and CDC first aid wording
  and send emergencies to 911; they do not diagnose.
* Air quality is a forecast model, not a monitor on the person's street.
* It plans waking hours, 6 am to 10 pm, and the heat index is one number for one point. Shade, air
  conditioning and exertion change real risk.
* Text messages need the AWS account's SMS service activated, and while it is in its sandbox only verified numbers
  receive them.
* A learned limit comes from what the person reports, not a measurement, and it only tightens.
* Thirteen tools by default. On fifteen varied sentences through the live talking demo, Claude Haiku 4.5 chose an
  expected tool for 13, which is why the demo now runs Sonnet 5.5, which got 33 of 34 conversation turns right; the same sentence can come out differently from run to run, and tool choice on real Alexa+
  still has to be tested.
* The WBGT is estimated from weather variables, not measured with three thermometers. Globe
  temperature follows Hunter and Minyard (1999) and natural wet bulb follows Malchaire (1976); the
  authoritative method is Liljegren et al. (2008) and this sits within one or two degrees Celsius of
  it outdoors. Close enough to change a decision, not close enough to certify a workplace.
* The NIOSH limits it is compared against were written for acclimatised healthy adults doing light
  work, which is precisely not this customer. They are used to say "you are past the line drawn for a
  fit adult at work", which has a source behind it, and never to prescribe a work-rest cycle.
* Device recalls match on equipment category, not on a product, because openFDA has no structured
  device field. It can say some oxygen concentrators from a named firm are recalled. It cannot say
  yours is, and it says so.
* The near-match suggestion for a mangled drug name is an edit distance, not a phonetic match, so
  "Lasix" heard as "lasicks" is still missed. Nothing is ever substituted without the customer
  confirming it.
* The Alexa+ stand-in on the demo page is a model reading the real tool list, not Alexa. A description
  that works there can still fail on the device.
* Spoken answers come from Polly and exist for the demo and the video. Alexa+ does its own speech.

## Licence

Apache-2.0. Permissive, deliberately, and the same change of mind as Orbita, for the same reason
recorded there: copyleft protects the code and taxes the people best placed to make it useful. Here
that is a pharmacy system, a home care provider, or whoever ends up putting heat advice in front of
somebody whose medication has taken their sweating away. Apache rather than MIT for the patent
grant.
