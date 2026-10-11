# Latency

Measured by `node test-latency.mjs`, 20 calls per tool, over HTTP against the built
server on this machine, for a profile in Phoenix with two medications and one condition, with
the forecast already polled. Node v20.12.2. Last run 2026-10-11 00:47 UTC.

A voice turn is roughly half a second in total, and the add-on is one part of that.
Everything below is the server's own share, from request received to response written.

| tool | source | p50 ms | p95 ms | max ms | budget |
|---|---|---|---|---|---|
| `weather_check` | memory | 4.0 | 8.3 | 8.3 | 50 |
| `plan_my_day` | memory | 3.7 | 7.3 | 7.3 | 50 |
| `going_out_now` | memory | 2.8 | 4.1 | 4.1 | 50 |
| `warning_signs` | memory | 2.6 | 5.9 | 5.9 | 50 |
| `should_i_shovel` | memory | 3.4 | 5.0 | 5.0 | 50 |
| `weather_warnings` | memory | 4.4 | 21.4 | 21.4 | 50 |
| `storm_prep` | memory | 3.1 | 6.8 | 6.8 | 50 |
| `sun_check` | memory | 3.1 | 4.4 | 4.4 | 50 |
| `my_profile` | memory | 2.7 | 7.3 | 7.3 | 50 |
| `what_can_you_do` | memory | 2.6 | 4.6 | 4.6 | 50 |
| `log_outing` | memory | 2.8 | 5.7 | 5.7 | 50 |
| `medicine_recalls` | cached | 2.7 | 4.8 | 4.8 | 50 |

Three tools called one after another, as a single turn might: p50 11.0 ms, p95 14.5 ms.

The slowest answer here is `weather_warnings` at 21.4 ms p95. The first
`medicine_recalls` of the day took 4 ms because it reaches openFDA;
it is cached for twelve hours after that, and a failed check is never cached as an all clear.
