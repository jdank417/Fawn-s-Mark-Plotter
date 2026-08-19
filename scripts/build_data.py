#!/usr/bin/env python3
"""Rebuild data/marks.json from the raw club mark lists in data/sources/.

Run this whenever a club publishes an updated mark list:
    python3 scripts/build_data.py
"""
import csv, json, io, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "sources")
BYC = os.path.join(SRC, "byc_wednesday_marks.csv")
JYC = os.path.join(SRC, "jyc_thursday_marks.csv")
MBSA = os.path.join(SRC, "mbsa_marks.csv")
OUT = os.path.join(ROOT, "data", "marks.json")


def read_rows(path):
    # Source CSVs use non-standard backslash-escaped quotes inside quoted
    # fields (e.g. "GR \"TR\" GONG") instead of RFC4180 doubled quotes.
    # Normalize \" -> "" so csv.reader parses the embedded quotes correctly.
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    fixed = raw.replace('\\"', '""')
    return csv.DictReader(io.StringIO(fixed))


def num_or_none(s):
    s = (s or "").strip()
    return float(s) if s else None


def build_byc():
    marks = []
    for row in read_rows(BYC):
        name = row["name"].strip()
        if name.lower() == "not used":
            continue
        portable = "PORTABLE" in (row["govt_light"] or "").upper() or "portable" in name.lower()
        marks.append({
            "id": row["mark"],
            "label": row["mark"],
            "name": name,
            "govt_light": row["govt_light"] or None,
            "lat": num_or_none(row["latitude_dd"]),
            "lon": num_or_none(row["longitude_dd"]),
            "gov_number": row["gov_number"] or None,
            "portable": portable,
            "notes": row["notes"] or None,
        })
    return marks


def build_jyc():
    marks = []
    for row in read_rows(JYC):
        desc = row["description"].strip()
        # jyc csv columns: mark,name,description,latitude_dm,longitude_dm,latitude_dd,longitude_dd,notes
        govt_light = row["name"]  # the "name" column actually holds govt light text, e.g. G "15" Q G
        display_name = desc if desc else govt_light
        is_signal = "twice around" in display_name.lower()
        if is_signal:
            continue  # not a physical mark, skip from selectable list
        portable = ("portable" in (govt_light or "").lower()) or ("portable" in display_name.lower())
        marks.append({
            "id": row["mark"],
            "label": row["mark"],
            "name": display_name,
            "govt_light": govt_light or None,
            "lat": num_or_none(row["latitude_dd"]),
            "lon": num_or_none(row["longitude_dd"]),
            "gov_number": None,
            "portable": portable,
            "notes": row["notes"] or None,
        })
    return marks


def build_mbsa():
    lists = {"A": [], "B": [], "C": []}
    for row in read_rows(MBSA):
        lst = row["list"]
        name = row["name"].strip()
        portable = "portable" in name.lower() or "drop mark" in name.lower()
        lists[lst].append({
            "id": row["mark"],
            "label": row["mark"],
            "name": name,
            "govt_light": row["govt_light"] or None,
            "lat": num_or_none(row["latitude"]),
            "lon": num_or_none(row["longitude"]),
            "gov_number": row["gov_number"] or None,
            "portable": portable,
            "notes": row["notes"] or None,
        })
    return lists


def main():
    byc_marks = build_byc()
    jyc_marks = build_jyc()
    mbsa_lists = build_mbsa()

    data = {
        "meta": {
            "sources": [
                "MBSA Yearbook (massbaysailing.org) - Standard Rounding Marks Lists A, B, C",
                "bostonyc.org BYC Wednesday Evening Races mark list (dated 5/2/13 - verify currency each season)",
                "jycracing.org JYC Thursday Night Series, Appendix A",
            ],
            "note": (
                "All weekend/regatta racing at BYC, EYC, CYC and JYC uses the shared MBSA "
                "Standard Rounding Marks (Lists A/B/C). BYC's Wednesday Night Series and "
                "JYC's Thursday Night Series each use their own club-specific letter list instead."
            ),
            "disclaimer": (
                "Always confirm marks and course against the official Sailing Instructions / "
                "Race Committee signals before racing. Positions for portable marks are set on "
                "the water and are not fixed."
            ),
        },
        "clubs": {
            "BYC": {
                "name": "Boston Yacht Club",
                "weeknight_series": {"id": "byc_wednesday", "label": "Wednesday Night Series"},
            },
            "EYC": {"name": "Eastern Yacht Club"},
            "CYC": {"name": "Corinthian Yacht Club"},
            "JYC": {
                "name": "Jubilee Yacht Club",
                "weeknight_series": {"id": "jyc_thursday", "label": "Thursday Night Series"},
            },
        },
        "lists": {
            "byc_wednesday": {"label": "BYC Wednesday Night Series", "marks": byc_marks},
            "jyc_thursday": {"label": "JYC Thursday Night Series", "marks": jyc_marks},
            "mbsa_A": {"label": "MBSA Standard List A", "marks": mbsa_lists["A"]},
            "mbsa_B": {"label": "MBSA Standard List B", "marks": mbsa_lists["B"]},
            "mbsa_C": {"label": "MBSA Standard List C", "marks": mbsa_lists["C"]},
        },
    }

    with open(OUT, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

    print("Wrote", OUT)
    for k, v in data["lists"].items():
        n_portable = sum(1 for m in v["marks"] if m["portable"])
        print(f"  {k}: {len(v['marks'])} marks, {n_portable} portable")


if __name__ == "__main__":
    main()
