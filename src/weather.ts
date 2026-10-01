/**
 * Open-Meteo client, background-refreshed, one snapshot per registered location.
 *
 * Measured live before writing this file: a single Open-Meteo forecast call
 * takes 420 to 480 ms on its own, before any of this server's own work.
 * Alexa+ allows roughly 500 ms total. So, exactly like Orbita and NOAA, nothing
 * here is ever fetched inside a tool call. A background timer refreshes every
 * registered location, and every tool call reads what is already in memory.
 *
 * Times are the part that went wrong first. Without a timezone, Open-Meteo
 * returns GMT wall clock strings with no Z on the end, and JavaScript reads a
 * string with no Z as the server's own local time. On a machine in Central
 * time that put "when does it ease off" five hours out. Now every request asks
 * for the location's own timezone, keeps that wall clock string for speaking,
 * and converts it to a real UTC instant with the offset Open-Meteo returns.
 *
 * Air quality comes from Open-Meteo's separate air quality API, because on hot
 * afternoons ozone is part of the danger for heart and lung conditions. If that
 * call fails the weather still works, with air quality unknown rather than zero.
 *
 * No API key, no documented rate limit, free for non-commercial use.
 */

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const REFRESH_MS = 20 * 60 * 1000;

export type Hour = {
  /** Wall clock at the location, "2026-09-12T15:00". What gets spoken. */
  local: string;
  /** The same moment as a real UTC instant. What gets compared. */
  time: string;
  tempF: number;
  humidityPct: number;
  uvIndex: number;
  /** Miles per hour, because wind chill is defined in mph. */
  windMph: number;
  isDay: boolean;
  /** US AQI, null when the air quality call did not answer. */
  aqi: number | null;
  /** Downward shortwave radiation, W/m2. Zero at night. The sun's own load. */
  solarWm2: number;
  /** Psychrometric wet bulb, Fahrenheit, as Open-Meteo reports it. */
  wetBulbF: number;
};

export type LocationSnapshot = {
  lat: number;
  lon: number;
  fetchedAt: string;
  timezone: string;
  utcOffsetSeconds: number;
  tempF: number;
  humidityPct: number;
  uvIndex: number;
  /** Miles per hour, for wind chill. */
  windMph: number;
  isDay: boolean;
  aqi: number | null;
  /** Downward shortwave radiation right now, W/m2. */
  solarWm2: number;
  /** Psychrometric wet bulb right now, Fahrenheit. */
  wetBulbF: number;
  /** Today and tomorrow, hourly, in the location's own timezone. */
  hourly: Hour[];
  stale: boolean;
  error?: string;
};

const snapshots = new Map<string, LocationSnapshot>();
const timers = new Map<string, NodeJS.Timeout>();
const key = (lat: number, lon: number) => `${lat.toFixed(3)},${lon.toFixed(3)}`;

/** "2026-09-12T15:00" at a UTC offset of -25200 seconds is 22:00 UTC. */
export function localToUtc(local: string, utcOffsetSeconds: number): string {
  return new Date(Date.parse(`${local}Z`) - utcOffsetSeconds * 1000).toISOString();
}

/** Pure, so the timezone handling is tested without the network. */
export function parseForecast(lat: number, lon: number, weather: any, air: any, fetchedAt = new Date()): LocationSnapshot {
  const offset = Number(weather?.utc_offset_seconds ?? 0);
  const aqiAt = new Map<string, number | null>();
  (air?.hourly?.time ?? []).forEach((t: string, i: number) => aqiAt.set(t, air.hourly.us_aqi?.[i] ?? null));
  const h = weather?.hourly ?? {};
  const hourly: Hour[] = (h.time ?? []).map((local: string, i: number) => ({
    local,
    time: localToUtc(local, offset),
    tempF: h.temperature_2m[i],
    humidityPct: h.relative_humidity_2m[i],
    uvIndex: h.uv_index?.[i] ?? 0,
    windMph: h.wind_speed_10m?.[i] ?? 0,
    isDay: h.is_day?.[i] === 1,
    solarWm2: h.shortwave_radiation?.[i] ?? 0,
    wetBulbF: h.wet_bulb_temperature_2m?.[i] ?? h.temperature_2m[i],
    aqi: aqiAt.get(local) ?? null,
  }));
  return {
    lat,
    lon,
    fetchedAt: fetchedAt.toISOString(),
    timezone: weather?.timezone ?? 'UTC',
    utcOffsetSeconds: offset,
    tempF: weather.current.temperature_2m,
    humidityPct: weather.current.relative_humidity_2m,
    uvIndex: weather.current.uv_index ?? 0,
    windMph: weather.current.wind_speed_10m ?? 0,
    isDay: weather.current.is_day === 1,
    solarWm2: weather.current.shortwave_radiation ?? 0,
    wetBulbF: weather.current.wet_bulb_temperature_2m ?? weather.current.temperature_2m,
    aqi: air?.current?.us_aqi ?? null,
    hourly,
    stale: false,
  };
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function refreshOne(lat: number, lon: number): Promise<void> {
  const k = key(lat, lon);
  const prior = snapshots.get(k);
  const [weather, air] = await Promise.allSettled([
    fetchJson(
      `${FORECAST}?latitude=${lat}&longitude=${lon}` +
        '&current=temperature_2m,relative_humidity_2m,uv_index,is_day,wind_speed_10m,shortwave_radiation,wet_bulb_temperature_2m' +
        // shortwave_radiation and wet_bulb_temperature_2m are what turn a heat
        // index, which assumes shade, into a WBGT, which does not. Same call.
        '&hourly=temperature_2m,relative_humidity_2m,uv_index,is_day,wind_speed_10m,shortwave_radiation,wet_bulb_temperature_2m' +
        '&forecast_days=2&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto',
    ),
    fetchJson(`${AIR}?latitude=${lat}&longitude=${lon}&current=us_aqi&hourly=us_aqi&forecast_days=2&timezone=auto`),
  ]);

  if (weather.status === 'fulfilled') {
    snapshots.set(k, parseForecast(lat, lon, weather.value, air.status === 'fulfilled' ? air.value : null));
    return;
  }
  // A stale reading you know is stale beats a fresh one that silently failed
  // to update. Keep serving the last good snapshot and say how old it is.
  const error = String(weather.reason);
  if (prior) {
    snapshots.set(k, { ...prior, stale: true, error });
  } else {
    snapshots.set(k, {
      lat, lon, fetchedAt: new Date().toISOString(), timezone: 'UTC', utcOffsetSeconds: 0,
      tempF: NaN, humidityPct: NaN, uvIndex: NaN, windMph: NaN, isDay: false, aqi: null,
      solarWm2: NaN, wetBulbF: NaN, hourly: [], stale: true, error,
    });
  }
}

/**
 * How many places this process will follow, and on whose behalf.
 *
 * Every followed place is a permanent twenty minute timer and two outbound calls to
 * a free service per tick, and `register_location` takes a raw latitude and longitude
 * from whoever is talking. With no ceiling, ten thousand invented coordinates are ten
 * thousand timers and a hundred thousand requests an hour to Open-Meteo, which is how
 * a free API decides to stop answering this address, for everybody.
 *
 * Two tiers. A place followed for a linked account has a hard ceiling and is never
 * evicted: that customer asked, and had to set a passphrase to do it. A place followed
 * only for the public sandbox is capped far lower and evicts the oldest when full, so
 * a newcomer is never refused and a flood can only ever displace other sandboxes.
 *
 * The default is the restrictive tier. A caller that cannot say it is acting for a
 * linked account gets the evictable one, so forgetting to pass the flag fails safe.
 */
const MAX_ACCOUNT_WATCHED = Number(process.env.SUDOR_MAX_WATCHED ?? 1500);
const MAX_DEMO_WATCHED = Number(process.env.SUDOR_MAX_DEMO_WATCHED ?? 150);
const demoOnly = new Set<string>();

function stopWatching(k: string): void {
  const t = timers.get(k);
  if (t) clearInterval(t);
  timers.delete(k);
  snapshots.delete(k);
  demoOnly.delete(k);
}

/** Start (or confirm) a background refresh loop for one location. Idempotent. */
export function watch(lat: number, lon: number, forAccount = false): void {
  const k = key(lat, lon);
  if (timers.has(k)) {
    // A linked account asking for a place a sandbox already followed takes it over,
    // so it stops being a candidate for eviction.
    if (forAccount) demoOnly.delete(k);
    return;
  }
  if (forAccount) {
    if (timers.size - demoOnly.size >= MAX_ACCOUNT_WATCHED) return;
  } else {
    while (demoOnly.size >= MAX_DEMO_WATCHED) stopWatching(demoOnly.values().next().value as string);
    demoOnly.add(k);
  }
  void refreshOne(lat, lon);
  const timer = setInterval(() => void refreshOne(lat, lon), REFRESH_MS);
  timer.unref?.();
  timers.set(k, timer);
}

/** For /health: how many places are being followed, split by whose they are. */
export function watched(): { accounts: number; sandbox: number } {
  return { accounts: timers.size - demoOnly.size, sandbox: demoOnly.size };
}

export function current(lat: number, lon: number): LocationSnapshot | null {
  return snapshots.get(key(lat, lon)) ?? null;
}

export function ageMinutes(lat: number, lon: number): number | null {
  const s = current(lat, lon);
  if (!s) return null;
  return Math.round((Date.now() - new Date(s.fetchedAt).getTime()) / 60000);
}

/** For tests: register a snapshot directly, no network. */
export function seedForTest(snap: LocationSnapshot): void {
  snapshots.set(key(snap.lat, snap.lon), snap);
}

export function stopAll(): void {
  for (const t of timers.values()) clearInterval(t);
  timers.clear();
  demoOnly.clear();
}
