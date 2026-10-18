# Latency

Measured by `node test-latency.mjs`, 20 calls per tool, over HTTP against the built
server on this machine, for a profile in Phoenix with two medications and one condition, with
the forecast already polled. Node v20.12.2. Last run 2026-10-18 06:00 UTC.

A voice turn is roughly half a second in total, and the add-on is one part of that.
Everything below is the server's own share, from request received to response written.

| tool | source | p50 ms | p95 ms | max ms | budget |
|---|---|---|---|---|---|
| `weather_check` | memory | 12.7 | 37.6 | 37.6 | 50 |
| `plan_my_day` | memory | 10.5 | 15.1 | 15.1 | 50 |
| `going_out_now` | memory | 10.2 | 14.8 | 14.8 | 50 |
| `warning_signs` | memory | 10.1 | 16.1 | 16.1 | 50 |
| `should_i_shovel` | memory | 10.1 | 16.0 | 16.0 | 50 |
| `weather_warnings` | memory | 9.8 | 12.7 | 12.7 | 50 |
| `storm_prep` | memory | 9.6 | 15.3 | 15.3 | 50 |
| `sun_check` | memory | 9.4 | 14.1 | 14.1 | 50 |
| `my_profile` | memory | 9.3 | 12.5 | 12.5 | 50 |
| `what_can_you_do` | memory | 8.9 | 14.7 | 14.7 | 50 |
| `log_outing` | memory | 9.6 | 18.2 | 18.2 | 50 |
| `medicine_recalls` | cached | 10.5 | 14.4 | 14.4 | 50 |

Three tools called one after another, as a single turn might: p50 28.7 ms, p95 35.2 ms.

The slowest answer here is `weather_check` at 37.6 ms p95. The first
`medicine_recalls` of the day took 13 ms because it reaches openFDA;
it is cached for twelve hours after that, and a failed check is never cached as an all clear.
