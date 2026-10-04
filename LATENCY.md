# Latency

Measured by `node test-latency.mjs`, 20 calls per tool, over HTTP against the built
server on this machine, for a profile in Phoenix with two medications and one condition, with
the forecast already polled. Node v20.12.2. Last run 2026-10-04 19:28 UTC.

A voice turn is roughly half a second in total, and the add-on is one part of that.
Everything below is the server's own share, from request received to response written.

| tool | source | p50 ms | p95 ms | max ms | budget |
|---|---|---|---|---|---|
| `weather_check` | memory | 7.4 | 21.0 | 21.0 | 50 |
| `plan_my_day` | memory | 7.0 | 10.2 | 10.2 | 50 |
| `going_out_now` | memory | 6.6 | 11.3 | 11.3 | 50 |
| `warning_signs` | memory | 5.3 | 9.1 | 9.1 | 50 |
| `should_i_shovel` | memory | 5.7 | 8.6 | 8.6 | 50 |
| `weather_warnings` | memory | 5.6 | 7.0 | 7.0 | 50 |
| `storm_prep` | memory | 5.4 | 12.0 | 12.0 | 50 |
| `sun_check` | memory | 4.1 | 7.8 | 7.8 | 50 |
| `my_profile` | memory | 3.6 | 7.4 | 7.4 | 50 |
| `what_can_you_do` | memory | 4.7 | 9.1 | 9.1 | 50 |
| `log_outing` | memory | 5.1 | 12.4 | 12.4 | 50 |
| `medicine_recalls` | cached | 5.2 | 8.4 | 8.4 | 50 |

Three tools called one after another, as a single turn might: p50 16.3 ms, p95 22.4 ms.

The slowest answer here is `weather_check` at 21.0 ms p95. The first
`medicine_recalls` of the day took 29 ms because it reaches openFDA;
it is cached for twelve hours after that, and a failed check is never cached as an all clear.
