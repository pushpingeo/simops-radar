"""Build the data files for SIMOPS Radar.

Inputs
  - PETS yearly spreadsheets (PETS_Application_Data_<year>.xls) from
    https://itportal.energysecurity.gov.uk/eng/fox/beis/PETS_EXTERNAL_PUBLICATION/main
  - NSTA licensed + unlicensed block layers (WGS84) as GeoJSON

Outputs (in data/)
  - activities.json  one row per activity (survey, rig/vessel operation, pipeline works)
  - pairs.json       every pair of activities in the same or a touching block with overlapping windows
  - blocks.geojson   whole blocks that have activity, plus their neighbours
  - meta.json        operator list, build date, counts

The page does the filtering (operator, rules, dates) in the browser.

Usage: python3 -I scripts/build_data.py <pets xls dir> <block geojson dir> <out dir>
"""
import sys, re, glob, json, datetime
import pandas as pd
import geopandas as gpd

PETS_DIR, GEODIR, OUT = sys.argv[1:4]
NOTIFY_DAYS = 30
FIRST_DAY = pd.Timestamp("2019-01-01")

# ---------------- operator groups ----------------
GROUP_RULES = [  # (regex on operator name, group label)
    (r"^SHELL", "Shell"), (r"^(BP |BRITOIL)", "BP"), (r"^NEO NEXT", "NEO NEXT"),
    (r"^(ENI |LIVERPOOL BAY CCS)", "Eni"), (r"^(HARBOUR|CHRYSAOR|PREMIER OIL)", "Harbour Energy"),
    (r"^EQUINOR", "Equinor"), (r"^CNOOC", "CNOOC"), (r"^ITHACA", "Ithaca Energy"),
    (r"^(SPIRIT ENERGY|CENTRICA)", "Spirit Energy / Centrica"), (r"^SERICA", "Serica Energy"),
    (r"^PERENCO", "Perenco"), (r"^TAQA", "TAQA"), (r"^DANA", "Dana Petroleum"), (r"^APACHE", "Apache"),
    (r"^CNR ", "CNR International"), (r"^ENQUEST", "EnQuest"), (r"^INEOS", "INEOS"), (r"^ONE-DYAS", "ONE-Dyas"),
    (r"^NET ZERO NORTH SEA", "Northern Endurance (NZNS)"), (r"^ADURA", "Adura"), (r"^CGG", "CGG"),
    (r"^PGS", "PGS"), (r"^TGS", "TGS"), (r"^FAIRFIELD", "Fairfield"), (r"^PETROGAS", "Petrogas"),
    (r"^ANASURIA", "Anasuria"), (r"^PX ", "PX"), (r"^AKER BP", "Aker BP"),
]
# Joint ventures: activities also count for their parents
ALSO_OWNED_BY = {"Adura": ["Shell", "Equinor"]}


def tidy(name):
    n = re.sub(r"\s+(LIMITED|LTD|PLC|LLC|ASA|AS|B\.V\.|S\.A\.S\.)\.?$", "", name.strip(), flags=re.I)
    n = n.title()
    for a, b in [(r"\bUk\b", "UK"), (r"U\.K\.", "UK"), (r"\bCb&I\b", "CB&I"), (r"\bDno\b", "DNO"), (r"\bE&P\b", "E&P"),
                 (r"\bSns\b", "SNS"), (r"\bCcs\b", "CCS"), (r"\bGni\b", "GNI"), (r"\bIog\b", "IOG"), (r"\bEdt\b", "EDT"),
                 (r"\bBp\b", "BP"), (r"\bCnr\b", "CNR"), (r"\bCgg\b", "CGG"), (r"\bPgs\b", "PGS"), (r"\bTgs\b", "TGS"),
                 (r"\bRogb\b", "ROGB"), (r"\bOde\b", "ODE"), (r"\bNeo Next\b", "NEO NEXT"), (r"\bGx\b", "GX"), (r"\bCnooc\b", "CNOOC"), (r"\bAbp\b", "ABP"), (r"\bBbl\b", "BBL"), (r"\bBhp\b", "BHP"), (r"\bGb\b", "GB"), (r"\bAs\b", "AS"), (r"\bCns\b", "CNS"), (r"\bEnquest\b", "EnQuest"), (r"\bConocophillips\b", "ConocoPhillips")]:
        n = re.sub(a, b, n)
    return n


def group_of(op):
    for rx, g in GROUP_RULES:
        if re.search(rx, op, re.I):
            return g
    return tidy(op)


def owners_of(op):
    g = group_of(op)
    return [g] + ALSO_OWNED_BY.get(g, [])


# ---------------- blocks ----------------
b = pd.concat([gpd.read_file(f) for f in sorted(glob.glob(f"{GEODIR}/*.geojson"))], ignore_index=True)
b = gpd.GeoDataFrame(b, geometry="geometry", crs=4326)
b["key"] = b["QUADNO"].astype(str).str.strip().str.lower() + "/" + b["BLOCKNO"].astype(float).astype(int).astype(str)
blocks = b.dissolve(by="key").reset_index()[["key", "geometry"]]
bm = blocks.to_crs(27700)
bm["geometry"] = bm.buffer(10)
adj = gpd.sjoin(bm, bm, predicate="intersects")
adj = adj[adj.key_left != adj.key_right]
NEIGH = adj.groupby("key_left")["key_right"].apply(set).to_dict()


def norm_block(s):
    m = re.match(r"\s*(\d{1,3})\s*/\s*0*(\d{1,2})", str(s))
    return f"{int(m.group(1))}/{int(m.group(2))}" if m else None


# ---------------- PETS ----------------
frames = []
for f in sorted(glob.glob(f"{PETS_DIR}/*.xls")):
    x = pd.read_excel(f, sheet_name=None, header=None)
    for sheet in ["Drilling", "Pipeline", "Well Intervention", "Production", "Decommissioning", "Standalone"]:
        df = x[sheet].iloc[2:].copy()
        df.columns = [str(c).strip() for c in x[sheet].iloc[1]]
        df = df.rename(columns={"MAT Refeence Number": "MAT Reference Number", "Start Quadrant/Block": "Quadrant/Block",
                                "MoDU/Vessel": "MoDU", "Field/Prospect": "Field", "Fields Ceasing Production": "Field",
                                "Main Pipeline Number": "Pipeline", "Main Pipeline Type": "Pipeline Type"})
        df["sheet"] = sheet
        df["file"] = f.split("/")[-1]
        frames.append(df)
p = pd.concat(frames, ignore_index=True)
p["block"] = p["Quadrant/Block"].apply(norm_block)
for c in ["SAT Start Date", "SAT Expiry Date"]:
    p[c] = pd.to_datetime(p[c], errors="coerce")
p["ref"] = p["SAT Reference Number"].astype(str).str.strip()
p["base"] = p["ref"].str.rsplit("/", n=1).str[0]
p["ver"] = pd.to_numeric(p["ref"].str.rsplit("/", n=1).str[1], errors="coerce")
p["prefix"] = p["ref"].str.split("/").str[0]
p["status"] = p["Application Status"].astype(str)
p["atype"] = p["Application Type"].astype(str).str.replace("\n", " ")
p["Operator"] = p["Operator"].astype(str).str.strip()
p["MoDU"] = p["MoDU"].where(~p["MoDU"].astype(str).str.strip().str.lower().isin(["none", "nan", ""]))
p = p[~p["status"].str.contains("Rejected|Surrender|Withdrawn", case=False)]
latest = p.sort_values(["ver", "file"]).groupby("base").tail(1)

VESSEL = re.compile(r"Bibby|Boka|Deep (Arctic|Discoverer|Explorer)|EDT|Edda|Grand Canyon|Havila|Island (Constructor|Frontier|Patriot|Valiant|Vanguard)|Seawell|Normand|Olympic|Seven |Siem|Well Enhancer|Energy Endeavour", re.I)


def s(v):
    return "" if pd.isna(v) or str(v).lower() == "nan" else str(v).strip()


def window(start, end):
    assumed = pd.isna(end)
    if assumed and pd.notna(start):
        end = start + pd.Timedelta(days=NOTIFY_DAYS)
    return start, end, assumed


acts = []
for _, r in latest[latest.prefix == "GS"].iterrows():
    t = r.atype
    if re.search(r"Vertical Seismic", t, re.I):
        cls = "vsp"
    elif re.search(r"3D Seismic|4D Seismic|OBC|OBS|4C", t, re.I):
        cls = "seismic"
    elif re.search(r"Notification", t, re.I):
        cls = "notice"
    else:
        cls = "site"
    start, end, assumed = window(r["SAT Start Date"], r["SAT Expiry Date"])
    detail = re.sub(r"^Consent to Undertake a Geophysical Survey\s*", "", t).strip()
    if detail.startswith("(") and detail.endswith(")"):
        detail = detail[1:-1]
    detail = detail or t
    acts.append(dict(cls=cls, op=r.Operator, block=r.block, start=start, end=end, assumed=assumed,
                     label=detail, field=s(r.get("Field")), unit="", refs=[r.ref], mat=s(r["MAT Reference Number"])))

rv = latest[latest["MoDU"].notna() & latest.sheet.isin(["Drilling", "Well Intervention", "Decommissioning"])]
for mat, g in rv.groupby("MAT Reference Number"):
    cl = g[g.atype.str.contains("Locate a Mobile", case=False)]
    dr = g[g.prefix == "DR"]
    src = cl if len(cl) else (dr if len(dr) else g)
    start, end, assumed = window(src["SAT Start Date"].min(), src["SAT Expiry Date"].max())
    first = g.iloc[0]
    unit = s(first["MoDU"])
    kind = {"Drilling": "Drilling", "Well Intervention": "Well intervention", "Decommissioning": "Decommissioning"}[first.sheet]
    acts.append(dict(cls="vessel" if VESSEL.search(unit) else "rig", op=first.Operator, block=first.block, start=start, end=end,
                     assumed=assumed, label=kind, field=s(first.get("Field")), unit=unit, refs=sorted(src.ref), mat=s(mat)))

pw = latest[(latest.sheet == "Pipeline") & latest.prefix.isin(["PL", "DEP", "CL", "ML"])]
for mat, g in pw.groupby("MAT Reference Number"):
    start, end, assumed = window(g["SAT Start Date"].min(), g["SAT Expiry Date"].max())
    first = g.iloc[0]
    acts.append(dict(cls="subsea", op=first.Operator, block=first.block, start=start, end=end, assumed=assumed,
                     label=f"Pipeline works {s(first.get('Pipeline'))} ({s(first.get('Pipeline Type'))})".replace(" ()", ""),
                     field="", unit="", refs=sorted(g.ref), mat=s(mat)))

A = pd.DataFrame(acts)
A = A[A.start.notna() & A.block.notna() & (A.end >= FIRST_DAY)].reset_index(drop=True)
A["id"] = A.index
A["group"] = A.op.map(group_of)
A["owners"] = A.op.map(owners_of)
A["days"] = (A.end - A.start).dt.days + 1

# ---------------- pairs ----------------
SURV = {"seismic", "site", "notice", "vsp"}
R = A.to_dict("records")
by_block = {}
for r in R:
    by_block.setdefault(r["block"], []).append(r["id"])
pairs = []
for a in R:
    cands = set(by_block.get(a["block"], []))
    for nb in NEIGH.get(a["block"], ()):
        cands |= set(by_block.get(nb, []))
    for j in cands:
        if j <= a["id"]:
            continue
        c = R[j]
        if a["mat"] and a["mat"] == c["mat"]:
            continue
        if a["unit"] and a["unit"] == c["unit"]:
            continue  # the same rig or vessel: sequencing, not a clash
        if set(a["owners"]) & set(c["owners"]) and a["cls"] in SURV and c["cls"] in SURV:
            continue  # one operator's surveys: usually one campaign
        o_s, o_e = max(a["start"], c["start"]), min(a["end"], c["end"])
        ov = (o_e - o_s).days + 1
        if ov <= 0:
            continue
        pairs.append([a["id"], c["id"], 1 if a["block"] == c["block"] else 0,
                      o_s.strftime("%Y-%m-%d"), o_e.strftime("%Y-%m-%d"), ov])

# ---------------- write ----------------
blk_used = set(A.block)
blk_keep = blk_used | set().union(*[NEIGH.get(k, set()) for k in blk_used])
bl = blocks[blocks.key.isin(blk_keep)].copy()
bl["geometry"] = bl.geometry.simplify(0.0005)
bl["active"] = bl.key.isin(blk_used)
missing = sorted(blk_used - set(blocks.key))
bl.to_file(f"{OUT}/blocks.geojson", driver="GeoJSON", COORDINATE_PRECISION=4)

cent = blocks.set_index("key").geometry.to_crs(27700).centroid.to_crs(4326)
acts_out = []
for r in A.to_dict("records"):
    c = cent.get(r["block"])
    acts_out.append(dict(id=r["id"], cls=r["cls"], op=tidy(r["op"]), owners=r["owners"], block=r["block"],
                         xy=[round(c.x, 4), round(c.y, 4)] if c is not None else None,
                         start=r["start"].strftime("%Y-%m-%d"), end=r["end"].strftime("%Y-%m-%d"), assumed=bool(r["assumed"]),
                         label=r["label"], field=r["field"].title(), unit=r["unit"], refs=r["refs"], mat=r["mat"]))
json.dump(acts_out, open(f"{OUT}/activities.json", "w"), separators=(",", ":"))
json.dump(pairs, open(f"{OUT}/pairs.json", "w"), separators=(",", ":"))

ops = {}
for r in acts_out:
    for o in r["owners"]:
        ops[o] = ops.get(o, 0) + 1
meta = dict(built=datetime.date.today().isoformat(), notifyDays=NOTIFY_DAYS,
            years=sorted({int(f.split("_")[-1][:4]) for f in glob.glob(f"{PETS_DIR}/*.xls")}),
            operators=sorted([[k, v] for k, v in ops.items()], key=lambda x: -x[1]),
            counts=dict(activities=len(acts_out), pairs=len(pairs), blocks=len(bl)))
json.dump(meta, open(f"{OUT}/meta.json", "w"), indent=1)
print(json.dumps(meta["counts"]), "classes:", A.cls.value_counts().to_dict())
print("blocks in PETS not in NSTA layer:", missing)
