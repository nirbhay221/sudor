# The tools

Written from the server's own tool list by `scripts/skill-tools.mjs`. Do not edit by hand.

A tool marked "reads" changes nothing. A tool marked "writes" saves or sends something, so the person agrees first.

## `about_me`

Writes.

Tell the add-on about the customer, or read back what it knows: where they are, the medicines they take, the health conditions they have, medical equipment they rely on, whether the cooling at home works, and whether to keep those private. Call this when someone says where they live, names a medicine, a condition or equipment such as home oxygen, says their air conditioning is broken or how hot it is indoors, says they have stopped one, asks what you know about them, asks whether a medicine or their equipment has been recalled, asks to keep their health private, or says forget everything. Several things can be given at once. With nothing given it reads the profile back. It records details about the customer only, never about another person. It is not for the weather itself (use weather_check) and not for who to tell in an emergency (use contact).

| Argument | Values | Needed |
|---|---|---|
| `place` | string | no |
| `confirmPlace` | boolean | no |
| `medicines` | array | no |
| `stopMedicines` | array | no |
| `conditions` | array | no |
| `stopConditions` | array | no |
| `cooling` | working, broken, none, fan, power_cuts, cost | no |
| `livesAlone` | boolean | no |
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

## `get_help`

Writes.

Tell the customer's confirmed contacts, by email and straight away, that they need help, or with status safe that they are all right: what they said, roughly where they are, and the nearest open shelter and emergency department. Call this when someone says get help, call for help, tell my daughter I need help, let my family know, or asks for somebody to come, including while they are looking for somewhere to go. It cannot phone anyone and cannot reach 911, and the answer says so: read it in full. It is not for describing symptoms (use warning_signs, which also alerts contacts when it hears an emergency), and not for adding or removing a contact (use contact).

| Argument | Values | Needed |
|---|---|---|
| `what` | string | no |
| `status` | need_help, safe | no |

## `going_out_now`

Reads.

Precautions for going out right now when it cannot wait, in the heat or in the cold, tailored to this customer: their conditions, medications, UV and water. Call this when someone says they have to go out, have an appointment, must run an urgent errand, or asks what precautions to take. Pass step to hear the rest, and privatePrecautions when they ask for their private precautions. Use plan_my_day instead when they can choose when to go.

| Argument | Values | Needed |
|---|---|---|
| `step` | integer | no |
| `privatePrecautions` | boolean | no |

## `log_outing`

Writes.

Record how the customer felt after being out in the heat, fine or unwell. Feeling unwell sets a personal heat limit that future plans respect. Call this when they say they just got back, felt fine, or felt dizzy, faint, sick or overheated while out. If they feel unwell right now, also use warning_signs. It records something that already happened; it does not plan an outing (use plan_my_day).

| Argument | Values | Needed |
|---|---|---|
| `felt` | fine, unwell | yes |
| `minutes` | integer | no |
| `note` | string | no |

## `plan_my_day`

Reads.

Plan a day around the heat or the cold for this customer: the best window for going out and the hours to avoid, from the hourly forecast, their medications and conditions. Call this when someone asks when to go out, walk the dog, run errands, exercise or garden, when it cools down, or to plan today or tomorrow. For somebody who works outside fixed hours, pass shiftStart and shiftEnd and it plans the shift and its breaks, and pass startedWork when they say they are new to the job or just back. For one trip that cannot wait use going_out_now, and for whether it is safe this moment use weather_check.

| Argument | Values | Needed |
|---|---|---|
| `activity` | string | no |
| `minutes` | integer | no |
| `day` | today, tomorrow | no |
| `shiftStart` | integer | no |
| `shiftEnd` | integer | no |
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

## `somewhere_to_go`

Reads.

Find somewhere the customer can go when their home is too cold or too hot to stay in, usually after a power cut: open shelters from the federal shelter system near their address, whether each has a generator, step-free access or takes pets, and the 211 line for local warming and cooling centres. Call this when they say they have no heat, no power, no air conditioning, that the house is freezing or boiling, or ask where they can go. It is for finding a place; for advice on getting ready before a power cut use storm_prep.

No arguments.

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
