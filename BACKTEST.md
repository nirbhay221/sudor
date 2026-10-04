# Backtest: July 2026, replayed

Measured hourly weather (Open-Meteo archive), 6 am to 10 pm, through the same code the server runs.
"Anybody" has nothing registered. "This person" takes metoprolol and furosemide and has heart disease.

| City | Waking hours | Hours the two answers differ | Fine for anybody, not for this person | Days with no fine hour: anybody | Days with no fine hour: this person |
|---|---|---|---|---|---|
| Phoenix, Arizona | 496 | 296 (60%) | 70 (14%) | 5 of 31 | 24 of 31 |
| Houston, Texas | 496 | 383 (77%) | 66 (13%) | 0 of 31 | 2 of 31 |
| Tampa, Florida | 496 | 426 (86%) | 110 (22%) | 0 of 31 | 7 of 31 |
| St. Louis, Missouri | 496 | 318 (64%) | 151 (30%) | 0 of 31 | 2 of 31 |
| Chicago, Illinois | 496 | 180 (36%) | 112 (23%) | 0 of 31 | 1 of 31 |
| Minneapolis, Minnesota | 496 | 273 (55%) | 156 (31%) | 0 of 31 | 0 of 31 |

What this shows: how often the answer for one person differs from the answer for anybody, on real days.
What it does not show: that anybody was harmed or protected. UV and air quality are left out of both
columns because the archive does not carry them, so the difference is from heat alone.

Generated 2026-10-04 by `node evals/backtest.mjs`.
