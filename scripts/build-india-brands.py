"""
Build assets/india-brands.json: Indian brand name -> active ingredients.

Source: "A-Z Medicine Dataset of India" (Kaggle, CC BY-SA 4.0), mirrored at
github.com/junioralive/Indian-Medicine-Dataset. Run:

    python scripts/build-india-brands.py path/to/indian_medicine_data.csv

A brand is its name without strength and dosage form ("Amlong 5 Tablet" -> "amlong"). A brand is kept only
when every product under that name has the same ingredients, so a name that means different things in
different packs is left out rather than guessed. "Plus" and "Forte" stay part of the name, because they
usually mean a different mix. Discontinued products are skipped.
"""
import csv, json, re, sys, collections

FORMS = r"(tablets?|tab|capsules?|cap|syrup|suspension|injection|inj|drops?|cream|gel|ointment|lotion|solution|" \
        r"inhaler|rotacaps?|respules?|sachet|powder|spray|oral|dt|md|sr|er|xr|cr|od|mr|kit|strip|vial|" \
        r"infusion|granules|lozenges?|chewable|dispersible|effervescent|soft|gelatin|respule|transcaps|pen|cartridge|prefilled|syringe|mouthwash|shampoo|soap|serum|patch|liquid|dry|paediatric|pediatric|kid|kids|junior|nasal|eye|ear)"

def brand_of(name):
    s = name.lower()
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(r"\b\d+(\.\d+)?\s*(mg|mcg|g|ml|iu|%|w/w|w/v)?\b", " ", s)
    words = [w for w in re.split(r"[\s/]+", s) if w]
    while words and re.fullmatch(FORMS, words[-1]):
        words.pop()
    words = [w for w in words if not re.fullmatch(FORMS, w)]
    b = " ".join(words).strip(" -.,")
    return b if len(b) >= 3 else None

# Salt and ester forms are the same medicine for this purpose: metoprolol succinate and tartrate are both metoprolol.
SALTS = (
    r"\b(succinate|tartrate|hydrochloride|hcl|sodium|potassium|calcium|magnesium|besilate|besylate|maleate|mesylate|"
    r"fumarate|citrate|sulphate|sulfate|phosphate|acetate|bromide|dihydrate|monohydrate|trihydrate|anhydrous|"
    r"dipropionate|propionate|furoate|xinafoate|oxalate|medoxomil|cilexetil|axetil|pivoxil|disodium|bisulphate|bisulfate)\b"
)

def ingredient(part):
    s = re.sub(r"\(.*?\)", " ", part or "").lower()
    s = re.sub(SALTS, " ", s)
    s = re.sub(r"\s+", " ", s).strip(" ,.")
    return s or None

def main(path):
    seen = collections.defaultdict(set)
    rows = 0
    with open(path, encoding="utf8", errors="ignore") as f:
        r = csv.DictReader(f)
        for row in r:
            if (row.get("Is_discontinued") or "").strip().upper() == "TRUE":
                continue
            b = brand_of(row.get("name", ""))
            if not b:
                continue
            ings = tuple(sorted(i for i in (ingredient(row.get("short_composition1")), ingredient(row.get("short_composition2"))) if i))
            if not ings:
                continue
            seen[b].add(ings)
            rows += 1
    out = {b: list(next(iter(v))) for b, v in seen.items() if len(v) == 1}
    with open("assets/india-brands.json", "w", encoding="utf8") as f:
        json.dump({"source": "A-Z Medicine Dataset of India (Kaggle, CC BY-SA 4.0), via github.com/junioralive/Indian-Medicine-Dataset",
                   "licence": "CC BY-SA 4.0", "brands": out}, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"{rows} products, {len(seen)} brand names, {len(out)} kept (one meaning each)")

main(sys.argv[1])
