# Latency

Measured by `node test-latency.mjs`, 20 calls per tool, over HTTP against the built
server on this machine, for a profile in Phoenix with two medications and one condition, with
the forecast already polled. Node v20.12.2. Last run 2026-10-01 02:50 UTC.

A voice turn is roughly half a second in total, and the add-on is one part of that.
Everything below is the server's own share, from request received to response written.

| tool | source | p50 ms | p95 ms | max ms | budget |
|---|---|---|---|---|---|
| `weather_check` | memory | 2.9 | 8.5 | 8.5 | 50 |
| `plan_my_day` | memory | 2.3 | 4.5 | 4.5 | 50 |
| `going_out_now` | memory | 2.3 | 3.7 | 3.7 | 50 |
| `warning_signs` | memory | 1.8 | 2.5 | 2.5 | 50 |
| `should_i_shovel` | memory | 1.8 | 4.1 | 4.1 | 50 |
| `weather_warnings` | memory | 2.3 | 5.0 | 5.0 | 50 |
| `storm_prep` | memory | 1.7 | 3.9 | 3.9 | 50 |
| `sun_check` | memory | 1.9 | 3.6 | 3.6 | 50 |
| `my_profile` | memory | 1.7 | 4.3 | 4.3 | 50 |
| `what_can_you_do` | memory | 1.6 | 3.7 | 3.7 | 50 |
| `log_outing` | memory | 1.7 | 3.8 | 3.8 | 50 |
| `medicine_recalls` | cached | 1.8 | 3.8 | 3.8 | 50 |

Three tools called one after another, as a single turn might: p50 5.0 ms, p95 7.4 ms.

The slowest answer here is `weather_check` at 8.5 ms p95. The first
`medicine_recalls` of the day took 16 ms because it reaches openFDA;
it is cached for twelve hours after that, and a failed check is never cached as an all clear.
