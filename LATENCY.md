# Latency

Measured by `node test-latency.mjs`, 20 calls per tool, over HTTP against the built
server on this machine, for a profile in Phoenix with two medications and one condition, with
the forecast already polled. Node v20.12.2. Last run 2026-09-19 02:25 UTC.

A voice turn is roughly half a second in total, and the add-on is one part of that.
Everything below is the server's own share, from request received to response written.

| tool | source | p50 ms | p95 ms | max ms | budget |
|---|---|---|---|---|---|
| `weather_check` | memory | 3.1 | 7.3 | 7.3 | 50 |
| `plan_my_day` | memory | 2.2 | 3.8 | 3.8 | 50 |
| `going_out_now` | memory | 2.1 | 3.4 | 3.4 | 50 |
| `warning_signs` | memory | 2.5 | 5.1 | 5.1 | 50 |
| `should_i_shovel` | memory | 1.9 | 4.0 | 4.0 | 50 |
| `weather_warnings` | memory | 1.8 | 5.9 | 5.9 | 50 |
| `storm_prep` | memory | 1.8 | 4.1 | 4.1 | 50 |
| `sun_check` | memory | 1.9 | 4.1 | 4.1 | 50 |
| `my_profile` | memory | 2.4 | 5.2 | 5.2 | 50 |
| `what_can_you_do` | memory | 2.7 | 4.6 | 4.6 | 50 |
| `log_outing` | memory | 2.2 | 4.3 | 4.3 | 50 |
| `medicine_recalls` | cached | 3.1 | 5.0 | 5.0 | 50 |

Three tools called one after another, as a single turn might: p50 7.3 ms, p95 10.0 ms.

The slowest answer here is `weather_check` at 7.3 ms p95. The first
`medicine_recalls` of the day took 25 ms because it reaches openFDA;
it is cached for twelve hours after that, and a failed check is never cached as an all clear.
