"""
Build assets/brands-<CC>.json: a country's medicine brand names -> active ingredients, from its own regulator.

    python scripts/build-country-brands.py CA <dir with drug.txt and ingred.txt>
    python scripts/build-country-brands.py FR <dir with CIS_bdpm.txt and CIS_COMPO_bdpm.txt>
    python scripts/build-country-brands.py BR <path to DADOS_ABERTOS_MEDICAMENTOS.csv>
    python scripts/build-country-brands.py IT <path to Classe_A_per_nome_commerciale_<date>.csv>

Sources and terms:
  CA  Health Canada, Drug Product Database data extract, Open Government Licence - Canada.
      https://www.canada.ca/en/health-canada/services/drugs-health-products/drug-products/drug-product-database.html
  FR  ANSM, Base de donnees publique des medicaments. Free reuse, provided the data is not altered and the
      source and date are given: base-donnees-publique.medicaments.gouv.fr
  BR  ANVISA, Dados abertos de medicamentos registrados. https://dados.anvisa.gov.br/dados/
  IT  AIFA, lists of Class A medicines by trade name, open data. https://www.aifa.gov.it/en/liste-farmaci-a-h

Ingredients are kept in the country's own language ("nifedipino", "furosemide"). Sudor turns them into the
names its drug database uses when one is looked up (rxclass.ts). As for India, a brand is kept only when
every product under it has the same ingredients.
"""
import csv, json, os, re, sys, collections, datetime

FORMS = (r"(tablets?|tab|capsules?|cap|comprim[eé]s?|g[ée]lules?|sirop|solution|suspension|injectable|injection|"
         r"cr[eè]me|pommade|gel|collyre|spray|inhal|poudre|sachets?|comprimidos?|c[aá]psulas?|xarope|solu[cç][aã]o|"
         r"suspens[aã]o|pomada|gotas|injet[aá]vel|drag[eé]as?|oral|orale|cutan[ée]e|buvable|effervescent|"
         r"pellicul[ée]s?|s[ée]cable|lp|sr|xr|er|cr|xl|la|ret|retard|mg|mcg|ml|g|ui|u)")

def brand_of(name):
    s = name.lower()
    s = s.split(",")[0]
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(r"\b\d+([.,]\d+)?\s*(mg|mcg|µg|g|ml|ui|%)?\b", " ", s)
    words = [w for w in re.split(r"[\s/]+", s) if w and not re.fullmatch(FORMS, w)]
    b = " ".join(words).strip(" -.,")
    return b if len(b) >= 3 else None

SALTS = (r"\b(chlorhydrate|hydrochloride|sodique|sodium|potassique|potassium|calcique|calcium|magn[ée]sium|"
         r"succinate|tartrate|mal[ée]ate|m[ée]sylate|m[ée]silate|b[ée]silate|besylate|fumarate|citrate|sulfate|"
         r"phosphate|ac[ée]tate|bromure|bromide|monohydrat[ée]?|dihydrat[ée]?|anhydre|de|d|cloridrato|"
         r"maleato|besilato|succinato|tartarato|mesilato|fumarato|citrato|sulfato|fosfato|acetato|s[oó]dico|"
         r"pot[aá]ssic[oa]|c[aá]lcic[oa]|s[oó]dic[oa]|magn[eé]sic[oa]|monoidratad[oa]|di-?hidratad[oa]|hemi-?hidratad[oa]|"
         r"arginine|erbumine|tert-?butylamine|lysine|lisina|solu[cç][aã]o)\b")

def ingredient(s):
    s = re.sub(r"\(.*?\)", " ", s or "").lower()
    s = re.sub(r"[ée]quivalant [aà].*$", " ", s)
    s = re.sub(r"\b[dl]['’]", " ", s)
    s = re.sub(SALTS, " ", s)
    s = re.sub(r"\s+", " ", s).strip(" ,.'’")
    return s or None

def keep(products):
    seen = collections.defaultdict(set)
    for brand, ings in products:
        if brand and ings:
            seen[brand].add(tuple(sorted(set(ings))))
    return {b: list(next(iter(v))) for b, v in seen.items() if len(v) == 1}

def canada(d):
    drugs = {}
    with open(os.path.join(d, "drug.txt"), encoding="latin-1") as f:
        for row in csv.reader(f):
            if len(row) > 4 and row[2] == "Human":
                drugs[row[0]] = brand_of(row[4])
    ings = collections.defaultdict(list)
    with open(os.path.join(d, "ingred.txt"), encoding="latin-1") as f:
        for row in csv.reader(f):
            if len(row) > 2:
                ings[row[0]].append(ingredient(row[2]))
    return keep((drugs[c], [i for i in ings.get(c, []) if i]) for c in drugs)

def france(d):
    names = {}
    with open(os.path.join(d, "CIS_bdpm.txt"), encoding="latin-1") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) > 4 and "active" in p[4].lower():
                names[p[0]] = brand_of(p[1])
    ings = collections.defaultdict(list)
    with open(os.path.join(d, "CIS_COMPO_bdpm.txt"), encoding="latin-1") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) > 6 and p[6].strip() == "SA":
                ings[p[0]].append(ingredient(p[3]))
    return keep((names[c], [i for i in ings.get(c, []) if i]) for c in names)

def brazil(path):
    out = []
    with open(path, encoding="latin-1") as f:
        r = csv.DictReader(f, delimiter=";")
        for row in r:
            if (row.get("SITUACAO_REGISTRO") or "").strip().lower() != "ativo":
                continue
            ings = [ingredient(x) for x in re.split(r"\s*[+;]\s*|\s*,\s*", row.get("PRINCIPIO_ATIVO") or "") if x.strip()]
            out.append((brand_of(row.get("NOME_PRODUTO") or ""), [i for i in ings if i]))
    return keep(out)

def italy(path):
    out = []
    with open(path, encoding="latin-1") as f:
        r = csv.reader(f, delimiter=";")
        next(r, None)
        for row in r:
            if len(row) < 3:
                continue
            brand = brand_of(row[2].split("*")[0])
            ings = [ingredient(x) for x in re.split(r"\s*/\s*|\s*\+\s*", row[0]) if x.strip()]
            out.append((brand, [i for i in ings if i]))
    return keep(out)

SOURCES = {
    "IT": "AIFA, Liste dei farmaci di classe A per nome commerciale (open data), aifa.gov.it",
    "CA": "Health Canada Drug Product Database data extract (Open Government Licence - Canada)",
    "FR": "ANSM, Base de donnees publique des medicaments, base-donnees-publique.medicaments.gouv.fr",
    "BR": "ANVISA, Dados abertos de medicamentos registrados, dados.anvisa.gov.br",
}

cc, src = sys.argv[1].upper(), sys.argv[2]
brands = {"CA": canada, "FR": france, "BR": brazil, "IT": italy}[cc](src)
json.dump({"source": SOURCES[cc], "built": datetime.date.today().isoformat(), "brands": brands},
          open(f"assets/brands-{cc}.json", "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
print(cc, len(brands), "brands")
