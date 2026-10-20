---
name: sudor-heat-safety
description: Answers whether heat, cold, a storm or a power cut is dangerous for one particular person, from their own medicines, health conditions and home, using the Sudor MCP server. Use when someone asks if it is safe to go outside, when to go out, what to do about a weather warning or a power cut, where to go to cool down or warm up, says they feel unwell in the heat or the cold, names a medicine or condition to remember, or wants family told.
license: Apache-2.0
compatibility: Needs the Sudor MCP server connected over Streamable HTTP (MCP 2025-11-25 or later). Nothing else is installed or fetched.
metadata:
  author: nirbhay221
  version: "0.1.0"
  mcp-server: io.github.nirbhay221/sudor
---

# Sudor: is it safe for this person today

Sudor answers one question for one person: is the weather a problem for me, with the medicines I take and the
home I live in. The server holds the person's place, medicines, conditions, equipment and home cooling, reads the
live forecast and official warnings, and returns an answer written to be spoken.

Your job is to choose the right tool, say the answer as it was written, and carry the person through the steps
that follow.

## Before the first call

1. Check the server is connected. `scripts/connect.mjs` lists its tools without changing anything.
2. Read the server's `instructions` from the initialize reply. They say what this person has already saved, as
   counts and never values. If a place is saved, do not ask where they live.
3. Do not collect a profile first. Call the tool for what was asked. An answer says what is missing.

## Choosing the tool

| The person says | Call |
|---|---|
| Is it safe outside, how bad is the heat, how cold is it for me | `weather_check` |
| When should I go out, walk the dog, garden, plan tomorrow, my shift is seven to three | `plan_my_day` |
| I have to go out now, what precautions | `going_out_now` |
| I feel dizzy, sick, faint, too hot, too cold | `warning_signs`, at once, with their words |
| A storm is coming, there is a warning, the power may go | `storm_prep` |
| The power is out, the house is boiling or freezing, where can I go | `somewhere_to_go` |
| Get help, tell my daughter I need help | `get_help` |
| I take metoprolol, I have MS, my air conditioning is broken, I live in Phoenix | `about_me` |
| Tell my daughter on hot days, add or remove a contact | `contact` |
| Let my son check on me, how is Mum doing today | `share_my_day` |
| I am back and felt fine, I felt faint out there | `log_outing` |
| Go on, why, the rest | `tell_me_more` |
| What can you do | `what_can_you_do` |
| This week, which days can I garden, should I work from home on Thursday | `plan_my_week` |
| How many hot days this month, when does the hot season start here | `heat_patterns` |
| My doctor said on hot days to take my water pill in the morning, what did my doctor say | `doctor_plan` |
| I am going to Las Vegas on the 20th, will my trip be too hot | `my_trips` |

Arguments and the full wording of each tool are in [references/tools.md](references/tools.md).

## Following the chain

A bad day is several questions. Every answer says where it sits in one:

- `structuredContent.nextAction` is the next call, as a tool name and its arguments, or absent when there is none.
- `structuredContent.flow` holds `about` (what the conversation is working through), `done` (tools already
  answered in the last fifteen minutes), `next` and `then` (what usually follows).

How to use them:

1. Say the answer. It ends on the offer for the next step when there is one.
2. If the person agrees, call `nextAction` with the arguments given. Do not rebuild them.
3. A step that only reads may be run without asking when the person asked for the whole thing, such as "what
   should I do today".
4. A step that writes or sends (`contact`, `get_help`, `share_my_day`, `log_outing`, `about_me`) needs the
   person to say yes first.
5. When `nextAction` is absent, stop. A fine day is one answer.

The chains, with what each step says, are in [references/chains.md](references/chains.md).

## Saying the answer

The text in `content` is the answer. It is short on purpose, and the order is deliberate.

- Say it in full and in order. If it says to call 911, say that first.
- Keep every number, every medicine name and every phone number exactly as given.
- Do not add advice of your own, and never tell someone to stop or change a medicine. The answer already says
  "Keep taking it unless your doctor says otherwise" where that matters.
- Do not soften a warning or add reassurance the answer did not give.
- If the answer says the weather service could not be reached, say that. Do not guess the weather.
- Detail is held back until asked for. When the person says "go on" or "why", call `tell_me_more`.
- If the server's instructions name another language for this person, translate faithfully and keep the
  numbers, medicine names and emergency number as given.

## When an answer begins with a question

If Sudor told somebody earlier that their home was too hot to stay in, a later answer may begin "If you are still
there, want me to find somewhere cool now?" and name `somewhere_to_go` as the next step. Say it first, as given.
If they say yes, call it.

## When someone is unwell

Call `warning_signs` before asking anything, with what they said in `symptoms`. If the words describe confusion,
slurred speech, fainting or collapse, the answer leads with calling 911 and emails the person's confirmed
emergency contacts. Read it at once and in full.

Sudor cannot phone anyone and cannot reach 911. `get_help` emails confirmed contacts, and its answer says so.
Never tell the person that help has been called.

## Privacy

- Medicines and conditions belong to the person. `about_me` records them about the person only, never about
  someone else.
- `share_my_day` lets family ask how the day looks. It never reveals a medicine or a condition, and neither
  should you.
- Nobody is emailed until the person has confirmed that contact with `contact` and action `confirm`.
- "Forget everything" is `about_me` with `forget`.

## What it does not cover

- Named cooling centres come from twenty-three public lists: Maricopa County, New York City, New York
  State, Washington DC, Harris County, Riverside County, Los Angeles, Philadelphia, San Diego County, Maryland,
  San Antonio, Columbus, Cuyahoga County, Rhode Island, Toronto, British Columbia, Milwaukee, Chester and York
  Counties in Pennsylvania, Johnson County in Kansas, Lake County in Illinois, Ramsey County in Minnesota and
  Lincoln. Elsewhere the answer gives open shelters and the 211 line.
- Whether the power is already out at an address is known where a list is published: California, Duke
  Energy's areas in the Carolinas, Florida, Indiana, Ohio and Kentucky, and BC Hydro's in British Columbia.
  In Maryland, Pennsylvania, Ohio and Alliant Energy's Iowa and Wisconsin a large outage is said by county,
  "that is the county, not your street". Say it as given.
- It is not a diagnosis. For symptoms it gives first aid and when to call 911.

## Example

Person: "Is it safe for me to go out?" on a dangerous day.

1. `weather_check` says what it feels like outside, names the medicine that makes it worse and why, and ends
   "Want me to find the safest time to go out today?". `nextAction` names `plan_my_day`.
2. They say yes. `plan_my_day` gives the best window and the hours to avoid. When no hour is safe, `nextAction`
   names `going_out_now`, or `somewhere_to_go` for a home with no working cooling.
3. `somewhere_to_go` names the nearest open place and, when a contact is confirmed, `nextAction` names
   `get_help`.
4. They say yes. `get_help` emails the confirmed contact, and says plainly that it has not phoned anyone.
