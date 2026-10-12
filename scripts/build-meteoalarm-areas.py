"""
Build assets/meteoalarm-areas.json: the outline of every area MeteoAlarm warnings are issued for, simplified.

MeteoAlarm's feeds name the areas a warning covers by code, not by shape: EMMA_ID for most countries, NUTS3
for France. This joins the two public outline sets so a point can be looked up:

  EMMA_ID outlines: geocodes.json from the MIT-licensed "meteoalarm" package by Niklas Jordan,
    https://github.com/NiklasJordan/meteoalarm (src/meteoalarm/assets/geocodes.json)
  NUTS3 outlines: Eurostat GISCO, NUTS 2021, 1:20 million,
    https://gisco-services.ec.europa.eu/distribution/v2/nuts/ (c) EuroGeographics for the administrative boundaries

Run: python scripts/build-meteoalarm-areas.py geocodes.json NUTS_RG_20M_2021_4326_LEVL_3.geojson
Outlines are simplified to about a kilometre, which is far finer than a warning area.
"""
import json, sys
from shapely.geometry import shape, mapping

def simplify(geom):
    g = shape(geom).simplify(0.01, preserve_topology=True)
    m = mapping(g)
    def rnd(c):
        return [round(c[0], 3), round(c[1], 3)] if isinstance(c[0], (int, float)) else [rnd(x) for x in c]
    return {"type": m["type"], "coordinates": rnd(json.loads(json.dumps(m["coordinates"])))}

out = {}
emma = json.load(open(sys.argv[1], encoding="utf8"))["features"]
for f in emma:
    if f.get("geometry"):
        out["EMMA_ID:" + f["properties"]["code"]] = simplify(f["geometry"])
nuts = json.load(open(sys.argv[2], encoding="utf8"))["features"]
for f in nuts:
    code = f["properties"].get("NUTS_ID")
    if code and code.startswith("FR") and f.get("geometry"):
        out["NUTS3:" + code] = simplify(f["geometry"])
json.dump({"sources": "EMMA_ID: github.com/NiklasJordan/meteoalarm (MIT). NUTS3: Eurostat GISCO NUTS 2021, (c) EuroGeographics for the administrative boundaries.",
           "areas": out}, open("assets/meteoalarm-areas.json", "w", encoding="utf8"), separators=(",", ":"))
print(len(out), "areas")
