# The tools

Written from the server's own tool list by `scripts/skill-tools.mjs`. Do not edit by hand.

A tool marked "reads" changes nothing. A tool marked "writes" saves or sends something, so the person agrees first.

## `about_me`

Writes.

Tell the add-on about the customer, or read back what it knows: where they are, the medicines they take, the health conditions they have, medical equipment they rely on, whether the cooling and the heating at home work, and whether to keep those private. Call this when someone says where they live, names a medicine, a condition or equipment such as home oxygen, says their air conditioning or heating is broken, that they cannot afford to heat or cool, or how hot or cold it is indoors, says they have stopped one, asks what you know about them, asks whether a medicine or their equipment has been recalled, asks to keep their health private, or says forget everything. Several things can be given at once. With nothing given it reads the profile back. It records details about the customer only, never about another person (use household for the people at home). It is not for the weather itself (use weather_check) and not for who to tell in an emergency (use contact).

| Argument | Values | Needed |
|---|---|---|
| `place` | string | no |
| `confirmPlace` | boolean | no |
| `medicines` | array | no |
| `stopMedicines` | array | no |
| `conditions` | array | no |
| `stopConditions` | array | no |
| `cooling` | working, broken, none, fan, power_cuts, cost | no |
| `heating` | working, broken, none, cost, power_cuts, space_heater | no |
| `livesAlone` | boolean | no |
| `age` | integer | no |
| `noMedicines` | boolean | no |
| `noConditions` | boolean | no |
| `checkInBy` | integer | no |
| `topFloor` | boolean | no |
| `indoorTempF` | number | no |
| `equipment` | array | no |
| `stopEquipment` | array | no |
| `privacy` | boolean | no |
| `recalls` | boolean | no |
| `forget` | boolean | no |

## `contact`

Writes.

Manage the family members or caregivers who get emailed when it matters: if signs of heat stroke are described, the evening before a day that stays too hot, or both. action add stages someone and nothing is sent until action confirm, which the customer must say yes to first. action remove stops emailing them. Call this when someone says to tell, add, confirm or stop telling a family member or carer.

| Argument | Values | Needed |
|---|---|---|
| `action` | add, confirm, remove | yes |
| `name` | string | yes |
| `email` | string | no |
| `relation` | string | no |
| `when` | emergency, hot_day, both | no |

## `doctor_plan`

Writes.

Keeps what this customer's own doctor or pharmacist told them to do on hot or cold days, in their words, such as "on hot days take my water pill in the morning" or "drink an extra litre when it is over 90", and repeats it on those days. action add saves one, list reads them back, today says whether today is a day it applies, remove deletes one. It never suggests changing, skipping or stopping a medicine itself: only the clinician decides that. Call this when they say what their doctor told them for hot or cold weather, or ask what it was.

| Argument | Values | Needed |
|---|---|---|
| `action` | add, list, today, remove | yes |
| `says` | string | no |
| `medicine` | string | no |
| `when` | hot_days, cold_days, always | no |
| `privately` | boolean | no |

## `get_help`

Writes.

Tell the customer's confirmed contacts, by email and straight away, that they need help, or with status safe that they are all right: what they said, roughly where they are, and the nearest open shelter and emergency department. Call this when someone says get help, call for help, tell my daughter I need help, let my family know, or asks for somebody to come, including while they are looking for somewhere to go. It cannot phone anyone and cannot reach 911, and the answer says so: read it in full. It is not for describing symptoms (use warning_signs, which also alerts contacts when it hears an emergency), and not for adding or removing a contact (use contact).

| Argument | Values | Needed |
|---|---|---|
| `what` | string | no |
| `status` | need_help, safe | no |
| `who` | string | no |

## `going_out_now`

Reads.

Precautions for going out right now when it cannot wait, in the heat or in the cold, tailored to this customer: their conditions, medications, UV and water. Call this when someone says they have to go out, have an appointment, must run an urgent errand, or asks what precautions to take. Pass step to hear the rest, and privatePrecautions when they ask for their private precautions. Use plan_my_day instead when they can choose when to go.

| Argument | Values | Needed |
|---|---|---|
| `step` | integer | no |
| `privatePrecautions` | boolean | no |

## `heat_patterns`

Reads.

Looks back over the last week, month or year where this customer lives and counts the days that were too hot, or too cold, for them to be out, given their own medicines and conditions: how many, the worst day, when the hot season started and ended, the worst month, and how often they told us they felt unwell. Call this for how the last week or month has been, how many hot days there were, when the hot season usually starts, or patterns over the year. It looks back; for days ahead use plan_my_week.

| Argument | Values | Needed |
|---|---|---|
| `period` | week, month, year | no |
| `date` | string | no |

## `household`

Writes.

The other people who live with the customer, or are travelling with them: a partner, a parent, a baby, children. action add saves one person, or adds medicines or conditions to somebody already saved; list reads them back; remove takes one off; clear removes them all. Once somebody is saved, the answers about going out, the day and trips also say what the weather means for them. Call this when the customer talks about another person at home: "my mum lives with us and takes Lasix", "my husband has heart disease", "we have a baby", "my son is four". One call per person. Never for the customer themselves, whose own place, medicines and conditions are kept separately.

| Argument | Values | Needed |
|---|---|---|
| `action` | add, list, remove, clear | yes |
| `called` | string | no |
| `age` | integer | no |
| `ageGroup` | baby, young_child, child, teen, adult, older_adult | no |
| `medicines` | array | no |
| `conditions` | array | no |

## `log_outing`

Writes.

Record how the customer felt after being out in the heat, fine or unwell. Feeling unwell sets a personal heat limit that future plans respect. Call this when they say they just got back, felt fine, or felt dizzy, faint, sick or overheated while out. If they feel unwell right now, also use warning_signs. It records something that already happened; it does not plan an outing (use plan_my_day).

| Argument | Values | Needed |
|---|---|---|
| `felt` | fine, unwell | yes |
| `minutes` | integer | no |
| `note` | string | no |

## `my_trips`

Writes.

Trips and holidays this customer tells us about: where and which dates. action add saves one and checks it, check judges the days of a trip against their own medicines (from the forecast once it reaches the dates, otherwise from the same dates last year), list reads upcoming and past trips with how the past ones went, remove deletes one. Call this when they say they are going away, on holiday or travelling, or ask whether a trip will be too hot or cold.

| Argument | Values | Needed |
|---|---|---|
| `action` | add, check, list, remove | yes |
| `place` | string | no |
| `from` | string | no |
| `to` | string | no |
| `travellers` | array | no |

## `plan_my_day`

Reads.

Plan a day around the heat or the cold for this customer: the best window for going out and the hours to avoid, from the hourly forecast, their medications and conditions. Call this when someone asks when to go out, walk the dog, run errands, exercise or garden, when it cools down, or to plan today or tomorrow. For somebody who works outside fixed hours, pass shiftStart and shiftEnd and it plans the shift and its breaks, and pass startedWork when they are new to it or just back, and workplace when it is inside; plan_my_week does the whole week. For one trip that cannot wait use going_out_now, and for whether it is safe this moment use weather_check.

| Argument | Values | Needed |
|---|---|---|
| `activity` | string | no |
| `minutes` | integer | no |
| `day` | today, tomorrow | no |
| `shiftStart` | integer | no |
| `shiftEnd` | integer | no |
| `startedWork` | new, returning, settled | no |
| `workplace` | outside, hot_inside, cool_inside | no |

## `plan_my_week`

Reads.

The seven days ahead for this customer, judged against their own medicines and conditions: which days have hours to stay in, which need care, which are fine, and the best day for something they want to do. Pass workStart and workEnd when they say their working hours, and it says which days their trip to or from work falls in stay-in hours, so they can work from home that day. Pass workplace for work outside or in a hot place, and it plans each shift instead: breaks, and the build-up while new. Call this for this week, the next few days, a weekday by name past tomorrow, or working from home. For today or tomorrow alone use plan_my_day.

| Argument | Values | Needed |
|---|---|---|
| `activity` | string | no |
| `minutes` | integer | no |
| `workStart` | integer | no |
| `workEnd` | integer | no |
| `workDays` | array | no |
| `date` | string | no |
| `workplace` | outside, hot_inside, cool_inside | no |
| `startedWork` | new, returning, settled | no |

## `share_my_day`

Writes.

Let a family member or carer ask how this person's day is looking, from their own account, without ever hearing a medicine or a condition. Call this when someone says let my daughter check on me (invite, which gives a one-time code), I have a code (join), how is Mum doing today or should I check on Dad (check), or stop sharing (leave for the other person, stop to end it for everybody). It is not for adding somebody to be emailed; that is contact.

| Argument | Values | Needed |
|---|---|---|
| `action` | invite, join, check, leave, stop | yes |
| `crewLink` | string | no |
| `shiftStart` | integer | no |
| `shiftEnd` | integer | no |
| `code` | string | no |
| `as` | family, crew | no |
| `called` | string | no |
| `who` | string | no |

## `somewhere_to_go`

Reads.

Find somewhere the customer can go when their home is too cold or too hot to stay in, usually after a power cut: open shelters from the federal shelter system near their address, whether each has a generator, step-free access or takes pets, and the 211 line for local warming and cooling centres. Call this when they say they have no heat, no power, no air conditioning, that the house is freezing or boiling, or ask where they can go. It is for finding a place; for advice on getting ready before a power cut use storm_prep. Pass place when they name where they are in the same breath, "I am in Fairbanks and the power is out".

| Argument | Values | Needed |
|---|---|---|
| `place` | string | no |

## `storm_prep`

Reads.

What this customer should do about a hurricane, flood, tornado, winter storm, wildfire smoke, power cut or any other official warning where they live, fitted to their medicines and conditions: what to do first, medicines that need a fridge, equipment that needs power, dialysis, and whether to leave. Also a forecast geomagnetic storm. Call this when someone asks what to do about a warning or a disaster, how to prepare, mentions losing power, or asks whether the power is out where they live. It needs no arguments: it reads the warnings in force where they live itself, so do not ask which warning. It is advice on what to do, not somewhere to go once the power is already out (use somewhere_to_go).

No arguments.

## `tell_me_more`

Reads.

Continue the last answer. Answers are kept short for listening, and the detail is held back until asked for. Call this when the customer says go on, tell me more, why, what else, or the rest, straight after another answer. It takes no arguments and only continues; it does not answer a new question.

No arguments.

## `warning_signs`

Writes.

What to do when someone feels unwell in the heat or the cold: heat stroke and heat exhaustion in warm weather, hypothermia and frostbite in cold. Which one it answers follows the weather where the person is. Call it straight away, before asking anything, whenever someone says they feel unwell: dizzy, a headache, sick, weak, faint, cramps, or too hot or too cold. Pass what they describe. If it describes confusion, slurred speech, fainting or collapse, the answer tells them to call 911 and emails any confirmed emergency contacts: read it immediately and in full. It is for someone who feels unwell or asks about the signs; to record how an outing went afterwards use log_outing.

| Argument | Values | Needed |
|---|---|---|
| `symptoms` | string | no |
| `lastedMinutes` | integer | no |
| `where` | hard_work_or_exercise, hot_place, hot_car, outside, cool_indoors | no |
| `place` | string | no |

## `weather_check`

Reads.

Whether the weather right now, hot or cold, is a problem for this customer's own medications and conditions. Call this when someone asks if it is safe to be outside, to garden, to work outdoors, how bad the heat is, or how cold it is for them. It needs no arguments: it uses the place and medicines already saved. Read the answer aloud in full; it names what is driving the risk and what to do. It is the answer for right now. To choose a time of day use plan_my_day, and for someone who already feels unwell use warning_signs. Pass heard when they say got it after a reminder.

| Argument | Values | Needed |
|---|---|---|
| `heard` | boolean | no |

## `what_can_you_do`

Reads.

Explain what this add-on is for. Call this when the customer asks what you can do, what this is, or opens with something too vague to route. It changes nothing and needs no setup. Do not use it when they have asked a specific question, even a short one; use the tool for that.

No arguments.
