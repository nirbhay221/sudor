# Latency

Measured by `node test-latency.mjs`, 20 calls per tool, over HTTP against the built
server on this machine, for a profile in Phoenix with two medications and one condition, with
the forecast already polled. Node v20.12.2. Last run 2026-10-07 00:58 UTC.

A voice turn is roughly half a second in total, and the add-on is one part of that.
Everything below is the server's own share, from request received to response written.

| tool | source | p50 ms | p95 ms | max ms | budget |
|---|---|---|---|---|---|
| `weather_check` | memory | 11.5 | 33.2 | 33.2 | 50 |
| `plan_my_day` | memory | 7.5 | 17.7 | 17.7 | 50 |
| `going_out_now` | memory | 7.2 | 15.4 | 15.4 | 50 |
| `warning_signs` | memory | 6.2 | 13.3 | 13.3 | 50 |
| `should_i_shovel` | memory | 6.0 | 19.8 | 19.8 | 50 |
| `weather_warnings` | memory | 5.3 | 10.5 | 10.5 | 50 |
| `storm_prep` | memory | 6.1 | 9.9 | 9.9 | 50 |
| `sun_check` | memory | 6.5 | 10.8 | 10.8 | 50 |
| `my_profile` | memory | 5.6 | 9.8 | 9.8 | 50 |
| `what_can_you_do` | memory | 5.5 | 9.3 | 9.3 | 50 |
| `log_outing` | memory | 5.5 | 11.9 | 11.9 | 50 |
| `medicine_recalls` | cached | 8.1 | 14.4 | 14.4 | 50 |

Three tools called one after another, as a single turn might: p50 18.9 ms, p95 30.4 ms.

The slowest answer here is `weather_check` at 33.2 ms p95. The first
`medicine_recalls` of the day took 45 ms because it reaches openFDA;
it is cached for twelve hours after that, and a failed check is never cached as an all clear.
