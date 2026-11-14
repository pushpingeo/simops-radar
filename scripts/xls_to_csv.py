"""Convert PETS yearly spreadsheets into one tidy CSV per year.

The CSVs are what the repo keeps: they are small, they diff line by line, and the git
history then shows exactly which applications appeared or changed on which day.

Usage: python scripts/xls_to_csv.py <folder with PETS_Application_Data_<year>.xls> <out folder>
"""
import sys, glob, os, re
import pandas as pd

SHEETS = ["Drilling", "Pipeline", "Well Intervention", "Production", "Decommissioning", "Standalone"]
RENAME = {
    "MAT Refeence Number": "MAT Reference Number", "Start Quadrant/Block": "Quadrant/Block",
    "MoDU/Vessel": "MoDU", "Field/Prospect": "Field", "Field/Prospect Name": "Field",
    "Fields Ceasing Production": "Field", "Main Pipeline Number": "Pipeline", "Main Pipeline Type": "Pipeline Type",
}
KEEP = ["sheet", "Operator", "MAT Reference Number", "Field", "Quadrant/Block", "End Quadrant/Block", "MoDU",
        "Pipeline", "Pipeline Type", "Application Type", "SAT Reference Number", "Date SAT Submitted",
        "SAT Start Date", "SAT Expiry Date", "Application Status", "Completion Date"]
DATES = ["Date SAT Submitted", "SAT Start Date", "SAT Expiry Date", "Completion Date"]


def convert(path):
    x = pd.read_excel(path, sheet_name=None, header=None)
    missing = [s for s in SHEETS if s not in x]
    if missing:
        raise ValueError(f"{path}: missing sheets {missing}")
    frames = []
    for sheet in SHEETS:
        df = x[sheet].iloc[2:].copy()
        df.columns = [str(c).strip() for c in x[sheet].iloc[1]]
        df = df.rename(columns=RENAME)
        df["sheet"] = sheet
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    for c in KEEP:
        if c not in df:
            df[c] = None
    df = df[KEEP].copy()
    for c in DATES:
        df[c] = pd.to_datetime(df[c], errors="coerce").dt.strftime("%Y-%m-%d")
    for c in KEEP:
        if c not in DATES:
            df[c] = df[c].astype(str).str.replace(r"\s+", " ", regex=True).str.strip().replace({"nan": "", "None": ""})
    df = df[df["SAT Reference Number"] != ""]
    return df.sort_values(["SAT Reference Number", "sheet", "MAT Reference Number"]).reset_index(drop=True)


if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    files = sorted(glob.glob(os.path.join(src, "*.xls")))
    if not files:
        sys.exit(f"no .xls files in {src}")
    for f in files:
        year = re.search(r"(\d{4})", os.path.basename(f)).group(1)
        df = convert(f)
        dest = os.path.join(out, f"pets_{year}.csv")
        df.to_csv(dest, index=False)
        print(f"{os.path.basename(f)} -> {dest}: {len(df)} rows")
