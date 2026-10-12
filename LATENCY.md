# Latency

Measured by `node test-latency.mjs`, 20 calls per tool, over HTTP against the built
server on this machine, for a profile in Phoenix with two medications and one condition, with
the forecast already polled. Node v20.12.2. Last run 2026-10-11 23:15 UTC.

A voice turn is roughly half a second in total, and the add-on is one part of that.
Everything below is the server's own share, from request received to response written.

| tool | source | p50 ms | p95 ms | max ms | budget |
|---|---|---|---|---|---|
| `weather_check` | memory | 4.2 | 9.7 | 9.7 | 50 |
| `plan_my_day` | memory | 2.6 | 5.3 | 5.3 | 50 |
| `going_out_now` | memory | 2.4 | 4.3 | 4.3 | 50 |
| `warning_signs` | memory | 2.1 | 4.4 | 4.4 | 50 |
| `should_i_shovel` | memory | 2.1 | 4.2 | 4.2 | 50 |
| `weather_warnings` | memory | 2.9 | 16.6 | 16.6 | 50 |
| `storm_prep` | memory | 3.8 | 5.5 | 5.5 | 50 |
| `sun_check` | memory | 3.0 | 5.7 | 5.7 | 50 |
| `my_profile` | memory | 2.0 | 5.4 | 5.4 | 50 |
| `what_can_you_do` | memory | 2.1 | 3.6 | 3.6 | 50 |
| `log_outing` | memory | 1.9 | 4.9 | 4.9 | 50 |
| `medicine_recalls` | cached | 2.4 | 4.3 | 4.3 | 50 |

Three tools called one after another, as a single turn might: p50 6.4 ms, p95 9.2 ms.

The slowest answer here is `weather_warnings` at 16.6 ms p95. The first
`medicine_recalls` of the day took 4 ms because it reaches openFDA;
it is cached for twelve hours after that, and a failed check is never cached as an all clear.
