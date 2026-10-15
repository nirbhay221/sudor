# The chains

Each row is a step an answer can name as `nextAction`, and the condition the server applies before naming it.
The server decides from the person's own state. Never call a step the answer did not name.

## A day that is not safe outside

| After | When | Next |
|---|---|---|
| `weather_check` | the day is risky and there is a better hour | `plan_my_day` |
| `weather_check` | it is dangerously hot or cold indoors | `somewhere_to_go` |
| `weather_check` | an official warning is in force | `storm_prep` |
| `plan_my_day` | no hour is safe | `going_out_now` |
| `plan_my_day` | no hour is safe and the home has no working cooling | `somewhere_to_go` |
| `going_out_now` | more precautions are held back | `going_out_now` with the `step` given |

A fine day names nothing. That is one answer, and the conversation is over.

## The power, and somewhere to go

| After | When | Next |
|---|---|---|
| `storm_prep` | the advice is to leave, or the warning may take the power | `somewhere_to_go` |
| `storm_prep` | the power is already out at the address (California) | `somewhere_to_go` |
| `storm_prep` | staying put, and a contact is confirmed | `get_help` with `status: safe` |
| `somewhere_to_go` | a contact is confirmed | `get_help` |
| `get_help` | help was asked for and nowhere to go has been looked for yet | `somewhere_to_go` |

## Setting up

| After | When | Next |
|---|---|---|
| `about_me` | a place, medicine or condition was added | `weather_check` |
| `about_me` | the place given differs from the one saved | `about_me` with `confirmPlace: true` |
| `about_me` | they said the cooling is broken on a hot day | `somewhere_to_go` |
| `contact` | someone was added | `contact` with action `confirm`, after the person says yes |

## After an outing

| After | When | Next |
|---|---|---|
| `log_outing` | they felt unwell | `warning_signs` |

## Where a chain stops on purpose

`warning_signs` names no next step. When it hears an emergency it has already emailed the confirmed contacts,
and calling `get_help` straight after would email the same people twice.

## Reading `flow`

```json
{
  "about": "a day that is not safe outside",
  "done": ["weather_check", "plan_my_day"],
  "next": "going_out_now",
  "then": ["warning_signs"]
}
```

`done` is kept for fifteen minutes as tool names only. `next` is always the tool in `nextAction`. `then` is
what usually follows, and each of those tools still decides for itself whether its step applies.
