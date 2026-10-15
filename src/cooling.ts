/**
 * Cooling centres: a named, open, cool building near the person, in place of "call 211".
 *
 * The federal shelter list (shelters.ts) is built for disasters, and on an ordinary hot day it holds a handful of
 * shelters for the whole country. The places people actually go on a hot afternoon, the library, the senior
 * centre, the respite centre, are run by cities and counties, and the larger ones publish them as open map
 * layers with no key. Each list below is read whole on a timer, like the shelter list, so no person's location
 * goes anywhere: the distance arithmetic is done here.
 *
 *   Maricopa County, Arizona: the Heat Relief Network, kept by the Maricopa Association of Governments. Cooling
 *     centres, respite centres and hydration stations, with each day's opening hours and the season's dates.
 *   New York City: NYC Emergency Management's cooling centre finder, each centre marked open or closed.
 *   New York State: the Department of Health's 2026 cooling centres, county by county.
 *   Washington, DC: HSEMA's cooling centres, with who each one is open to.
 *   Harris County, Texas (Houston): the county emergency office's cooling centres, marked open or closed.
 *   Riverside County, California: the county's Cool Centers, marked open or closed.
 *   City of Los Angeles: centres the city has activated, a list that is empty until a heat event opens them.
 *   Philadelphia: the city's warming and cooling sites, each marked as a cooling site and open or closed.
 *   San Diego County: the Health and Human Services Agency's Cool Zones, libraries and community centres.
 *   Maryland: the Department of Health's cooling centres for every county and Baltimore City.
 *   San Antonio: the city's Places to Stay Cool, with each day's hours.
 *   Columbus, Ohio: the city's recreation centres, each marked as a cooling centre or not.
 *   Cuyahoga County, Ohio (Cleveland): centres the county emergency office has opened, with first and last days.
 *   Rhode Island: the state's cooling centres, town by town, with each day's hours.
 *   Toronto: Toronto Public Health's cooling centres and cooling locations, with each day's hours.
 *   British Columbia: the province's community response locations marked as public cooling spaces.
 *   Milwaukee: the city's cooling sites, without the splash pads and pools it lists beside them.
 *   Chester County and York County, Pennsylvania: the counties' cooling sites, libraries and senior centres.
 *   Johnson County, Kansas (Kansas City suburbs): the county health department's cooling centres.
 *   Lake County, Illinois (north of Chicago): the county's cooling and warming centres.
 *   Ramsey County, Minnesota (Saint Paul): the county's libraries kept as cooling centres.
 *   Lincoln, Nebraska: the city's cooling centre locations.
 *
 * Places a list marks closed, inactive or out of season are dropped. A failed read is "I could not check", never
 * "there is none", as everywhere else here.
 */

import { backoff } from './backoff.js';
import { milesBetween } from './shelters.js';

export type CoolingCentre = {
  name: string;
  address: string;
  /** "cooling centre", "respite centre", "library" and so on, as the list puts it. */
  kind: string;
  lat: number;
  lon: number;
  /** Hours as the list writes them, cleaned; null when it does not say. */
  hours: string | null;
  /** Today's opening and closing, "9 am" and "9 pm", when the list gives them day by day. */
  today?: { open: string; close: string } | null;
  phone: string | null;
  /** Who it is for when the list restricts it, "Men" or "Seniors"; null when anyone can go. */
  openTo: string | null;
  accessible: boolean | null;
  pets: boolean | null;
  source: string;
  milesAway?: number;
};

type Attrs = Record<string, unknown>;
type Source = {
  name: string;
  url: string;
  /** Turns one row into a centre, or null when the row is closed, inactive or not a place to stay. */
  read: (a: Attrs, geometry: { x?: number; y?: number } | undefined, today: Today) => CoolingCentre | null;
};
/** Today's date and weekday, where the lists are (all of them keep US Eastern to Pacific time). */
type Today = { date: string; weekday: string };

const text = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();
// Some lists carry their dashes double-encoded ("Mon â€“ Fri"), which a speech engine reads letter by letter.
const tidy = (v: unknown): string => text(v).replace(/â€“|â€”|–|—/g, '-').replace(/Ã³/g, 'ó');
const yes = (v: unknown): boolean => /^(y|yes|true|1)$/i.test(text(v));
const pointOf = (g: { x?: number; y?: number } | undefined, a: Attrs, latKey?: string, lonKey?: string) => {
  const lat = latKey ? Number(a[latKey]) : Number(g?.y);
  const lon = lonKey ? Number(a[lonKey]) : Number(g?.x);
  return Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 ? { lat, lon } : null;
};
/** "9:00 AM" to "9 am", "4:30 PM" to "4:30 pm". */
const clock = (v: unknown): string | null => {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(text(v));
  if (!m) return null;
  return `${Number(m[1])}${m[2] && m[2] !== '00' ? `:${m[2]}` : ''} ${m[3].toLowerCase()}m`;
};

/** "12pm-8pm", "9am-4:30pm", "9 AM - 5 PM": today's opening and closing; null for "Closed" or anything else. */
const span = (v: unknown): { open: string; close: string } | null => {
  const m = /^(\d{1,2}(?::\d{2})?)\s*([ap])\.?m\.?\s*(?:-|to)\s*(\d{1,2}(?::\d{2})?)\s*([ap])\.?m\.?$/i.exec(text(v));
  if (!m) return null;
  const open = clock(`${m[1]} ${m[2]}m`);
  const close = clock(`${m[3]} ${m[4]}m`);
  return open && close ? { open, close } : null;
};
/** "0900" or "2030", a 24 hour clock, to "9 am" or "8:30 pm". */
const clock24 = (v: unknown): string | null => {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(text(v));
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23) return null;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${m[2] !== '00' ? `:${m[2]}` : ''} ${h < 12 ? 'am' : 'pm'}`;
};
/** Philadelphia's "M-F; 9A-5P", "11AM-7PM Daily" or "9A-3P (M-Thursday)" as it should be heard. */
const phlHours = (v: unknown): string | null => {
  const t = text(v).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/^24\/7$/.test(t)) return 'open all day and night';
  return t
    .replace(/\bM-Sun\b|\bDaily\b/gi, 'every day')
    .replace(/\bM-F\b|\bWeekdays\b/gi, 'Monday to Friday')
    .replace(/\bM-Thursday\b/gi, 'Monday to Thursday')
    .replace(/\bWeekends\b/gi, 'at weekends')
    .replace(/(\d{1,2})(?::(\d{2}))?\s*([AP])M?\b/gi, (_m, h, mm, ap) => `${h}${mm ? `:${mm}` : ''} ${ap.toLowerCase()}m`)
    .replace(/\s*-\s*/g, ' to ')
    .replace(/\s*;\s*/g, ', ')
    .replace(/\s+,/g, ',')
    .trim();
};
/** Places that are cooling but outdoors in the sun, by the kind a list gives them. */
const OUTDOOR_KIND = /spray|splash|wading|wadding|pool|beach|fountain|misting|park|outdoor/i;

const SOURCES: Source[] = [
  {
    name: 'Maricopa County Heat Relief Network',
    url: 'https://services1.arcgis.com/MdyCMZnX1raZ7TS3/arcgis/rest/services/HRN_Public_view/FeatureServer/0',
    read: (a, g, today) => {
      if (!yes(a.Active) || !yes(a.HeatRelief)) return null;
      // A hydration station is water, not somewhere to sit out the afternoon.
      const kind = text(a.HeatRelief_Type);
      if (!/cooling|respite/i.test(kind)) return null;
      if (text(a.Start_Date) && text(a.Start_Date) > today.date) return null;
      if (text(a.End_Date) && text(a.End_Date) < today.date) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      const open = clock(a[`${today.weekday}Open`]);
      const close = clock(a[`${today.weekday}Close`]);
      // Hours kept day by day and none for today: closed today, so not somewhere to send anyone.
      const dayByDay = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].some((d) => clock(a[`${d}Open`]));
      if (dayByDay && !(open && close)) return null;
      return {
        name: text(a.Location) || text(a.Organization), address: text(a.Address), kind: kind.toLowerCase(), ...p,
        hours: tidy(a.Hours) || null, today: open && close ? { open, close } : null,
        phone: text(a.PrimaryPhone) || null, openTo: null,
        accessible: a.ADA_accessible == null ? null : yes(a.ADA_accessible), pets: a.Pets == null ? null : yes(a.Pets),
        source: 'Maricopa County Heat Relief Network',
      };
    },
  },
  {
    name: 'NYC Emergency Management cooling centers',
    url: 'https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/CoolingCenters_PROD_view/FeatureServer/0',
    read: (a, g, today) => {
      if (text(a.Finder_status).toUpperCase() !== 'OPEN') return null;
      const p = pointOf(g, a);
      if (!p) return null;
      const d = today.weekday.slice(0, 3).toLowerCase();
      const open = clock(a[`cc_${d}_open1`]);
      const close = clock(a[`cc_${d}_close1`]);
      const dayByDay = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].some((x) => clock(a[`cc_${x}_open1`]));
      if (dayByDay && !(open && close)) return null;
      return {
        name: text(a.Facility_name), address: [text(a.Address), text(a.Borough_name)].filter(Boolean).join(', '),
        kind: text(a.Facility_type) && !/other/i.test(text(a.Facility_type)) ? text(a.Facility_type).toLowerCase() : 'cooling centre', ...p,
        hours: tidy(a[today.weekday]) || null, today: open && close ? { open, close } : null,
        phone: text(a.Phone) || null, openTo: null,
        accessible: a.Accessible == null ? null : yes(a.Accessible), pets: a.Pet_friendly == null ? null : yes(a.Pet_friendly),
        source: 'NYC Emergency Management',
      };
    },
  },
  {
    name: 'New York State Department of Health cooling centers 2026',
    url: 'https://services8.arcgis.com/k1v79LrnPTwysMSs/arcgis/rest/services/NYS_Cooling_Centers_2026_/FeatureServer/0',
    read: (a, g) => {
      if (!yes(a.Active) || (text(a.Cooling_Centers) && !yes(a.Cooling_Centers))) return null;
      const p = pointOf(g, a, 'Lat', 'Long') ?? pointOf(g, a);
      if (!p) return null;
      const heatOnly = yes(a.Only_During_Heat_Waves_);
      return {
        name: text(a.Facility), address: text(a.Street_Address), kind: 'cooling centre', ...p,
        hours: [tidy(a.Hours_of_Operation), heatOnly ? 'open during heat waves only' : ''].filter(Boolean).join(', ') || null,
        phone: text(a.Contact_Number) || null, openTo: null, accessible: null, pets: null,
        source: 'New York State Department of Health',
      };
    },
  },
  {
    name: 'DC HSEMA cooling centers',
    url: 'https://services.arcgis.com/neT9SoYxizqTHZPH/arcgis/rest/services/DC_Cooling_Centers_View/FeatureServer/1',
    read: (a, g) => {
      if (!/^open/i.test(text(a.USER_Status))) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      const to = text(a.USER_Open_To);
      return {
        name: text(a.USER_Name), address: `${text(a.USER_Address)}, Washington`, kind: text(a.USER_Type).toLowerCase().replace(/s$/, '') || 'cooling centre', ...p,
        hours: tidy(a.USER_Hours) || null, phone: text(a.USER_Phone) || null,
        openTo: to && !/^(all|everyone|public|general public)$/i.test(to) ? to : null, accessible: null, pets: null,
        source: 'DC Homeland Security and Emergency Management Agency',
      };
    },
  },
  {
    name: 'Harris County cooling centers',
    url: 'https://services7.arcgis.com/S4q5OFlKdQkzQMZw/arcgis/rest/services/Cooling_Centers_(public_view)/FeatureServer/7',
    read: (a, g) => {
      if (!/^open$/i.test(text(a.OpenClosed))) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      return {
        name: text(a.Location), address: text(a.Address), kind: 'cooling centre', ...p,
        hours: tidy(a.OperationalHours) || null, phone: null, openTo: null, accessible: null, pets: null,
        source: 'Harris County Office of Homeland Security and Emergency Management',
      };
    },
  },
  {
    name: 'Riverside County Cool Centers',
    url: 'https://services1.arcgis.com/pWmBUdSlVpXStHU6/arcgis/rest/services/CAP_CoolCenters_0719_PublicView/FeatureServer/0',
    read: (a, g) => {
      if (!/^open$/i.test(text(a.Status))) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      return {
        name: text(a.Name), address: [text(a.Address), text(a.City)].filter(Boolean).join(', '), kind: text(a.Type).toLowerCase() || 'cooling centre', ...p,
        hours: tidy(a.Hours_of_Operation).replace(/\s*\(.*$/, '') || null, phone: text(a.Phone_Number) || null, openTo: null, accessible: null, pets: null,
        source: 'Riverside County',
      };
    },
  },
  {
    name: 'City of Los Angeles activated cooling centers',
    url: 'https://services7.arcgis.com/DSSF7DFVxfZsz379/arcgis/rest/services/Activated_Cooling_Heating_Centers_City_of_Los_Angeles/FeatureServer/0',
    read: (a, g) => {
      const p = pointOf(g, a);
      if (!p) return null;
      const name = text(a.Name ?? a.NAME ?? a.Facility ?? a.FACILITY ?? a.Site_Name ?? a.SITE_NAME);
      if (!name) return null;
      return {
        name, address: text(a.Address ?? a.ADDRESS), kind: 'cooling centre', ...p,
        hours: tidy(a.Hours ?? a.HOURS) || null, phone: text(a.Phone ?? a.PHONE) || null, openTo: null, accessible: null, pets: null,
        source: 'City of Los Angeles Emergency Management',
      };
    },
  },
  {
    name: 'Philadelphia warming and cooling sites',
    url: 'https://services.arcgis.com/fLeGjb7u4uXqeF9q/arcgis/rest/services/Warming_Cooling_Sites_PUBLICVIEW/FeatureServer/0',
    read: (a, g) => {
      if (!yes(a.cooling_site) || !/^open$/i.test(text(a.site_status))) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      return {
        name: text(a.site_name), address: `${text(a.site_address)}, Philadelphia`, kind: 'cooling centre', ...p,
        hours: phlHours(a.site_hours), phone: null, openTo: null,
        accessible: a.handicap_accessible == null ? null : yes(a.handicap_accessible), pets: null,
        source: 'City of Philadelphia',
      };
    },
  },
  {
    name: 'San Diego County Cool Zones',
    url: 'https://services1.arcgis.com/1vIhDJwtG5eNmiqX/arcgis/rest/services/HLTH_COOL_ZONES_PUBLIC/FeatureServer/0',
    read: (a, g) => {
      const p = pointOf(g, a);
      if (!p) return null;
      return {
        name: text(a.NAME) || text(a.Organization), address: [text(a.Address), text(a.City)].filter(Boolean).join(', '), kind: 'cooling centre', ...p,
        // The hours field repeats the name; the county sends people to coolzones.org for them.
        hours: null, phone: text(a.Phone).replace(/^\+1\s*/, '') || null, openTo: null, accessible: null,
        pets: /^service animals only$/i.test(text(a.PetPolicy)) ? false : null,
        source: 'County of San Diego Health and Human Services Agency',
      };
    },
  },
  {
    name: 'Maryland Department of Health cooling centers',
    url: 'https://services.arcgis.com/njFNhDsUCentVYJW/arcgis/rest/services/Maryland_Cooling_Centers_by_JurisdictionMDH_Jurisdictions_CoolingCenters_20260710/FeatureServer/16',
    read: (a, g) => {
      if (/closed/i.test(text(a.Note))) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      return {
        name: text(a.Cooling_Center), address: text(a.Location), kind: /homeless shelter/i.test(text(a.Note)) ? 'shelter' : 'cooling centre', ...p,
        hours: null, phone: null, openTo: /50\+/.test(text(a.Note)) ? 'adults 50 and over' : null, accessible: null, pets: null,
        source: 'Maryland Department of Health',
      };
    },
  },
  {
    name: 'San Antonio places to stay cool',
    url: 'https://services.arcgis.com/g1fRTDLeMgspWrYp/arcgis/rest/services/Cooling_Centers_Viewer/FeatureServer/0',
    read: (a, g, today) => {
      if (!/^active$/i.test(text(a.status)) || !/cooling/i.test(text(a.USETYPE))) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      const hoursToday = text(a[today.weekday.toUpperCase()]);
      if (/^closed$/i.test(hoursToday)) return null;
      return {
        name: text(a.NAME), address: [text(a.ADDRESS), text(a.CITY)].filter(Boolean).join(', '), kind: text(a.TYPE).toLowerCase() || 'cooling centre', ...p,
        hours: hoursToday || null, today: span(hoursToday), phone: text(a.PHONE) || null, openTo: null, accessible: null, pets: null,
        source: 'City of San Antonio',
      };
    },
  },
  {
    name: 'Columbus cooling centers',
    url: 'https://services1.arcgis.com/9yy6msODkIBzkUXU/arcgis/rest/services/CoolingCenters_view/FeatureServer/0',
    read: (a, g) => {
      if (!yes(a.CoolingCenter_YN)) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      const extended = /^none$/i.test(text(a.ExtendedHours)) ? '' : tidy(a.ExtendedHours);
      return {
        name: text(a.LABEL), address: [text(a.ADDRESS1), text(a.ADDRESS2)].filter(Boolean).join(', '), kind: text(a.LAYER_TYPE).toLowerCase() || 'cooling centre', ...p,
        hours: extended || tidy(a.RegularHours) || null, phone: null, openTo: null, accessible: null, pets: null,
        source: 'City of Columbus',
      };
    },
  },
  {
    name: 'Cuyahoga County cooling centers',
    url: 'https://services7.arcgis.com/GXM8JipKyc0m6HBi/arcgis/rest/services/Warming_and_Cooling_Submittal_view/FeatureServer/0',
    read: (a, g, today) => {
      if (text(a.centertype).toLowerCase() !== 'cooling' || !yes(a.publicview)) return null;
      // Open from its first day to its last, as the county enters them.
      const day = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? new Date(Number(v)).toISOString().slice(0, 10) : '');
      if (!day(a.firstday) || day(a.firstday) > today.date || (day(a.lastday) && day(a.lastday) < today.date)) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      return {
        name: text(a.centername), address: text(a.pntaddr), kind: 'cooling centre', ...p,
        hours: tidy(a.notes) || null, phone: text(a.centercontactphone) || null, openTo: null,
        accessible: a.ADAaccessible == null ? null : yes(a.ADAaccessible), pets: null,
        source: 'Cuyahoga County Office of Emergency Management',
      };
    },
  },
  {
    name: 'Rhode Island cooling centers',
    url: 'https://services1.arcgis.com/7arM4WYbUOtKu3Zq/arcgis/rest/services/RI_Cooling_Centers_July_2026/FeatureServer/0',
    read: (a, g, today) => {
      const p = pointOf(g, a);
      if (!p) return null;
      const hoursToday = text(a[`USER_${today.weekday}`]);
      if (/^closed$/i.test(hoursToday)) return null;
      return {
        name: text(a.USER_Name), address: [text(a.USER_Address), text(a.USER_Municipality)].filter(Boolean).join(', '), kind: 'cooling centre', ...p,
        hours: hoursToday || null, today: span(hoursToday), phone: text(a.USER_Location_Contact_Info) || null, openTo: null, accessible: null, pets: null,
        source: 'State of Rhode Island',
      };
    },
  },
  {
    name: 'Toronto Public Health cooling centres',
    url: 'https://services3.arcgis.com/b9WvedVPoizGfvfD/arcgis/rest/services/TPH_Cooling_Centres_View/FeatureServer/0',
    read: (a, g, today) => {
      if (!/^active$/i.test(text(a.status)) || OUTDOOR_KIND.test(text(a.locationTypeDesc))) return null;
      const p = pointOf(g, a, 'lat', 'lon') ?? pointOf(g, a);
      if (!p) return null;
      const d = today.weekday.slice(0, 3).toLowerCase();
      const open = clock24(a[`${d}Open`]);
      const close = clock24(a[`${d}Close`]);
      const dayByDay = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].some((x) => clock24(a[`${x}Open`]));
      if (dayByDay && !(open && close)) return null;
      return {
        name: text(a.locationName), address: `${text(a.address)}, Toronto`, kind: /centre/i.test(text(a.locationTypeDesc)) ? 'cooling centre' : 'cool place', ...p,
        hours: null, today: open && close ? { open, close } : null, phone: text(a.phone) || null,
        openTo: text(a.eligibility) || null, accessible: null, pets: null,
        source: 'Toronto Public Health',
      };
    },
  },
  {
    name: 'British Columbia public cooling spaces',
    url: 'https://services1.arcgis.com/xeMpV7tU1t4KD3Ei/arcgis/rest/services/Community_Response_Locations_Public_View/FeatureServer/0',
    read: (a, g) => {
      if (!/public cooling space/i.test(text(a.Site_Type)) || !/^open$/i.test(text(a.Site_Status))) return null;
      if (text(a.Review_Status) && !/^approved$/i.test(text(a.Review_Status))) return null;
      if (OUTDOOR_KIND.test(text(a.Site_Subtype)) || /drinking water|pop-up/i.test(text(a.Site_Subtype))) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      const hours = /operating hours:\s*(.+)$/i.exec(text(a.Other_Comments))?.[1] ?? null;
      return {
        name: text(a.Site_Label) || text(a.Site_Subtype), address: text(a.Site_Address_Location_Desc), kind: text(a.Site_Subtype).toLowerCase() || 'cooling centre', ...p,
        hours: hours ? tidy(hours) : null, phone: null, openTo: null, accessible: null, pets: null,
        source: 'Province of British Columbia, Emergency Management and Climate Readiness',
      };
    },
  },
  {
    name: 'Milwaukee cooling sites',
    url: 'https://services1.arcgis.com/5ly0cVV70qsN8Soc/arcgis/rest/services/MKE_Cooling_Sites_Hosted/FeatureServer/0',
    read: (a, g, today) => {
      if (/water recreation/i.test(text(a.Category))) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      const hoursToday = text(a[today.weekday]);
      if (/^closed$/i.test(hoursToday)) return null;
      return {
        name: text(a.Name), address: [text(a.Address), text(a.City) || 'Milwaukee'].filter(Boolean).join(', '), kind: text(a.Subcategor).toLowerCase() || 'cooling centre', ...p,
        hours: hoursToday || null, today: span(hoursToday), phone: text(a.Phone) || null, openTo: /senior/i.test(text(a.Subcategor)) ? 'older adults' : null, accessible: null, pets: null,
        source: 'City of Milwaukee',
      };
    },
  },
  {
    name: 'Chester County cooling sites',
    url: 'https://services.arcgis.com/G4S1dGvn7PIgYd6Y/arcgis/rest/services/Extreme_Heat_Cooling_Site/FeatureServer/0',
    read: (a, g) => {
      if (/pool|water/i.test(text(a.Type))) return null;
      const p = pointOf(g, a);
      if (!p) return null;
      return {
        name: text(a.Name), address: text(a.Address_Full) || text(a.Address), kind: text(a.Type).toLowerCase().replace(/s$/, '') || 'cooling centre', ...p,
        hours: tidy(a.Hours) || null, phone: text(a.Contact_Info) || null, openTo: /senior/i.test(text(a.Type)) ? 'older adults' : null, accessible: null, pets: null,
        source: 'Chester County, Pennsylvania',
      };
    },
  },
  {
    name: 'York County cooling centers',
    url: 'https://services1.arcgis.com/bzC4sqfGZJYY5WBz/arcgis/rest/services/York_County_Cooling_Centers/FeatureServer/0',
    read: (a, g) => {
      const p = pointOf(g, a);
      if (!p) return null;
      const phone = text(a.PhoneNumbe).replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');
      return {
        name: text(a.Name), address: text(a.Address), kind: yes(a.SeniorCent) ? 'senior centre' : 'cooling centre', ...p,
        hours: tidy(a.Access) || null, phone: phone || null, openTo: yes(a.SeniorCent) ? 'older adults' : null, accessible: null, pets: null,
        source: 'York County, Pennsylvania',
      };
    },
  },
  {
    name: 'Johnson County cooling centers',
    url: 'https://services.arcgis.com/VI7SIDfzMs53TTMm/arcgis/rest/services/DHE_Cooling_Centers_Public/FeatureServer/0',
    read: (a, g) => {
      const p = pointOf(g, a, 'Latitude', 'Longitude') ?? pointOf(g, a);
      if (!p) return null;
      const title = (v: unknown) => text(v).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
      return {
        name: title(a.FacilityName), address: [title(a.Address), title(a.City)].filter(Boolean).join(', '), kind: 'cooling centre', ...p,
        hours: null, phone: text(a.ContactPhone) || null, openTo: null, accessible: null, pets: null,
        source: 'Johnson County Department of Health and Environment, Kansas',
      };
    },
  },
  {
    name: 'Lake County cooling centers',
    url: 'https://services3.arcgis.com/HESxeTbDliKKvec2/arcgis/rest/services/Cooling_and_Warming_Centers_of_Lake_County__IEMA_View/FeatureServer/0',
    read: (a, g) => {
      const p = pointOf(g, a);
      if (!p) return null;
      return {
        name: text(a.Facility_Name), address: text(a.Facility_Address).replace(/,\s*$/, ''), kind: 'cooling centre', ...p,
        hours: tidy(a.Hours_of_Operation) || null, phone: text(a.Phone_Number) || null, openTo: null, accessible: null, pets: null,
        source: 'Lake County Emergency Management Agency, Illinois',
      };
    },
  },
  {
    name: 'Ramsey County cooling centers',
    url: 'https://services2.arcgis.com/527XtFVf9JKOTqu5/arcgis/rest/services/CoolingCenters/FeatureServer/2',
    read: (a, g) => {
      const p = pointOf(g, a);
      if (!p) return null;
      return {
        name: text(a.Name), address: [text(a.Address), text(a.City)].filter(Boolean).join(', '), kind: 'library', ...p,
        hours: null, phone: null, openTo: null, accessible: null, pets: null,
        source: 'Ramsey County, Minnesota',
      };
    },
  },
  {
    name: 'Lincoln cooling centers',
    url: 'https://services1.arcgis.com/wpJGOi6N4Rq5cqFv/arcgis/rest/services/Cooling_Center_Locations_-_Lincoln/FeatureServer/0',
    read: (a, g) => {
      const p = pointOf(g, a);
      if (!p) return null;
      return {
        name: text(a.Name), address: `${text(a.Address)}, Lincoln`, kind: 'cooling centre', ...p,
        hours: tidy(a.Hours).split(/\n/)[0] || null, phone: text(a.Phone_Number) || null, openTo: null, accessible: null, pets: null,
        source: 'City of Lincoln, Nebraska',
      };
    },
  },
];

const EVERY_MS = 30 * 60 * 1000;
const STALE_MS = 3 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

/** Each list's centres, held separately, so one list failing does not empty the others. */
const held = new Map<string, { centres: CoolingCentre[]; checkedAt: number }>();

function todayEastern(): Today {
  // The lists are all in US time zones; a weekday a few hours off at midnight does not move an opening hour much.
  const now = new Date(Date.now() - 6 * 3_600_000);
  return { date: now.toISOString().slice(0, 10), weekday: now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) };
}

async function readSource(src: Source): Promise<CoolingCentre[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const q = new URLSearchParams({ where: '1=1', outFields: '*', outSR: '4326', returnGeometry: 'true', resultRecordCount: '2000', f: 'json' });
    const res = await fetch(`${src.url}/query?${q}`, { signal: ctrl.signal, headers: { 'User-Agent': 'sudor/0.1 (Alexa+ add-on; heat and cold safety)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { features?: { attributes?: Attrs; geometry?: { x?: number; y?: number } }[]; error?: { message?: string } };
    if (body.error || !Array.isArray(body.features)) throw new Error(body.error?.message ?? 'no features');
    const today = todayEastern();
    return body.features
      .map((f) => src.read(f.attributes ?? {}, f.geometry, today))
      .filter((c): c is CoolingCentre => !!c && !!c.name)
      // A spray pad, a pool or a beach is cooling, and it is outdoors in the sun: not what someone on a water pill
      // with a heart condition is being sent to.
      .filter((c) => !/spray|splash|pool|beach|fountain|park\b/i.test(c.name))
      // Hours that are only the word "closed", or "temporarily closed", is a centre not open at all.
      .filter((c) => !/^(temporarily\s+)?closed\b/i.test(c.hours ?? ''))
      .map((c) => {
        const only = /[-(,\s]*\b(older adults|seniors?|adults 60\+?|60\+)\s*only\b\)?/i.exec(c.name);
        return only ? { ...c, name: c.name.replace(only[0], '').trim(), openTo: c.openTo ?? 'older adults' } : c;
      });
  } catch (err) {
    console.error(`[cooling] could not read ${src.name}:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let readOne: (src: Source) => Promise<CoolingCentre[] | null> = readSource;
const gates = new Map(SOURCES.map((s) => [s.name, backoff()]));

/*
 * One list at a time. Sixteen lists parsed at once put tens of milliseconds of work on the event loop in one go,
 * in front of whatever answer was being served; one after another, the same work is spread out and no answer
 * waits on more than one list.
 */
async function poll(): Promise<void> {
  for (const src of SOURCES) {
    const gate = gates.get(src.name)!;
    if (!gate.ready()) continue;
    const fresh = await readOne(src);
    if (fresh) {
      gate.ok();
      held.set(src.name, { centres: fresh, checkedAt: Date.now() });
    } else {
      gate.fail();
      const was = held.get(src.name);
      if (was && Date.now() - was.checkedAt > STALE_MS) held.delete(src.name);
    }
    await new Promise((r) => setImmediate(r));
  }
}

export async function start(): Promise<void> {
  await poll();
  const timer = setInterval(() => void poll(), EVERY_MS);
  timer.unref?.();
}

/** Where the lists reach: a person outside every one of them is told nothing about cooling centres from here. */
const COVERS: { name: string; lat: [number, number]; lon: [number, number] }[] = [
  { name: 'Maricopa County Heat Relief Network', lat: [32.4, 34.1], lon: [-113.4, -111.0] },
  { name: 'NYC Emergency Management cooling centers', lat: [40.45, 40.95], lon: [-74.3, -73.65] },
  { name: 'New York State Department of Health cooling centers 2026', lat: [40.45, 45.1], lon: [-79.8, -71.8] },
  { name: 'DC HSEMA cooling centers', lat: [38.79, 39.0], lon: [-77.12, -76.9] },
  { name: 'Harris County cooling centers', lat: [29.45, 30.2], lon: [-95.97, -94.9] },
  { name: 'Riverside County Cool Centers', lat: [33.4, 34.1], lon: [-117.7, -114.4] },
  { name: 'City of Los Angeles activated cooling centers', lat: [33.7, 34.35], lon: [-118.7, -118.1] },
  { name: 'Philadelphia warming and cooling sites', lat: [39.86, 40.14], lon: [-75.29, -74.95] },
  { name: 'San Diego County Cool Zones', lat: [32.53, 33.51], lon: [-117.6, -116.08] },
  { name: 'Maryland Department of Health cooling centers', lat: [37.88, 39.73], lon: [-79.49, -75.04] },
  { name: 'San Antonio places to stay cool', lat: [29.2, 29.75], lon: [-98.85, -98.2] },
  { name: 'Columbus cooling centers', lat: [39.8, 40.16], lon: [-83.2, -82.77] },
  { name: 'Cuyahoga County cooling centers', lat: [41.27, 41.63], lon: [-82.0, -81.38] },
  { name: 'Rhode Island cooling centers', lat: [41.14, 42.02], lon: [-71.91, -71.1] },
  { name: 'Toronto Public Health cooling centres', lat: [43.58, 43.86], lon: [-79.64, -79.11] },
  { name: 'British Columbia public cooling spaces', lat: [48.2, 60.0], lon: [-139.1, -114.0] },
  { name: 'Milwaukee cooling sites', lat: [42.84, 43.2], lon: [-88.07, -87.84] },
  { name: 'Chester County cooling sites', lat: [39.72, 40.25], lon: [-76.14, -75.44] },
  { name: 'York County cooling centers', lat: [39.72, 40.24], lon: [-77.15, -76.22] },
  { name: 'Johnson County cooling centers', lat: [38.73, 39.06], lon: [-95.06, -94.6] },
  { name: 'Lake County cooling centers', lat: [42.15, 42.5], lon: [-88.2, -87.8] },
  { name: 'Ramsey County cooling centers', lat: [44.88, 45.13], lon: [-93.23, -92.98] },
  { name: 'Lincoln cooling centers', lat: [40.7, 40.92], lon: [-96.8, -96.55] },
];

/**
 * Open centres within reach, nearest first. Null when this place is covered by a list that could not be read
 * (say "I could not check"); undefined when no list here covers it at all (say nothing, and fall back to 211).
 */
export function near(lat: number, lon: number, withinMiles = 10): CoolingCentre[] | null | undefined {
  const covering = COVERS.filter((c) => lat >= c.lat[0] && lat <= c.lat[1] && lon >= c.lon[0] && lon <= c.lon[1]);
  if (!covering.length) return undefined;
  const lists = covering.map((c) => held.get(c.name)).filter((h) => h && Date.now() - h.checkedAt <= STALE_MS);
  if (!lists.length) return null;
  const seen = new Set<string>();
  return lists
    .flatMap((h) => h!.centres)
    .map((c) => ({ ...c, milesAway: milesBetween(lat, lon, c.lat, c.lon) }))
    .filter((c) => (c.milesAway ?? Infinity) <= withinMiles)
    .sort((a, b) => (a.milesAway ?? 0) - (b.milesAway ?? 0))
    // The city and the state list the same library; the nearer copy is kept.
    .filter((c) => {
      const key = `${c.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** One spoken sentence about the nearest, or an empty string. */
export function sentence(c: CoolingCentre): string {
  const miles = c.milesAway ?? 0;
  const away = miles < 1 ? 'less than a mile away' : `about ${Math.round(miles)} ${Math.round(miles) === 1 ? 'mile' : 'miles'} away`;
  const kind = /respite/.test(c.kind) ? 'respite centre' : 'cooling centre';
  const where = `${c.name.replace(/\s+$/, '')}${c.address ? `, at ${c.address}` : ''}, ${away}`;
  // "Open" only when the list says today's hours; otherwise its hours are read out, so a closed day is heard.
  if (c.today) return `The nearest ${kind} open today is ${where}, from ${c.today.open} to ${c.today.close}.`;
  // "9:00 AM" is said "9 AM" and "12:30PM" "12 30 PM"; a colon after a word ("Monday: 9 am") is a pause.
  const heard = (h: string) =>
    h
      .replace(/\s*-\s*/g, ' to ')
      .replace(/(\d):00\b/g, '$1')
      .replace(/(\d):(\d\d)/g, '$1 $2')
      .replace(/(\d)\s*([AP])\.?M\.?\b/gi, (_m, d, ap) => `${d} ${ap.toLowerCase()}m`)
      .replace(/:\s*/g, ' ');
  const hours = c.hours && c.hours.length <= 60 ? ` Its hours: ${heard(c.hours)}.` : '';
  return `The nearest ${kind} is ${where}.${hours}`;
}

export const counts = (): Record<string, number> => Object.fromEntries([...held].map(([k, v]) => [k, v.centres.length]));

export function seedForTest(name: string, centres: CoolingCentre[] | null, checkedAt = Date.now()): void {
  if (centres) held.set(name, { centres, checkedAt });
  else held.delete(name);
}
export function configureForTest(fake: ((src: { name: string }) => Promise<CoolingCentre[] | null>) | null): void {
  readOne = fake ?? readSource;
  held.clear();
}
export const sourceNames = (): string[] => SOURCES.map((s) => s.name);
