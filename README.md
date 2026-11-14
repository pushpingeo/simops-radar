# SIMOPS Radar

Early warning of clashing offshore operations on the UK continental shelf, built from the regulator's public consent data.

**Live:** https://pushpingeo.github.io/simops-radar/

## The problem

Two operators working in the same patch of sea at the same time is a SIMOPS problem: simultaneous operations. A seismic vessel shooting near a dive or well intervention vessel, or a rig waiting for another to clear a location. A seismic vessel costs around $250,000 a day and a rig around $500,000, so a one-day delay is already a six-figure problem. Survey planners try to catch these clashes by hand.

## What this does

Almost every survey, rig, well intervention and pipeline job on the UK shelf needs an environmental consent from OPRED, and OPRED publishes the list (PETS). SIMOPS Radar:

1. Reads the PETS yearly spreadsheets from 2019 to 2026.
2. Turns them into activities: seismic surveys (3D, 4D, ocean-bottom), site surveys, rigs, intervention and dive vessels, and pipeline works. Each activity gets a licence block and a consent window.
3. Pairs up activities in the same or a neighbouring block whose windows overlap.
4. Scores each pair on how much it's likely to matter: the type of pair, same or neighbouring block, whether the dates are real or assumed, how long the overlap is, and how vague the consent windows are.

In the page you pick an operator, choose a sensitivity, and play the years back on the map. Each alert says which rules flagged it.

On the quiet setting most operators get between none and a handful of alerts a year, which is about what a planner would expect to need to act on.

## The example

In summer 2019, Shell held a 3D seismic consent in block 21/29 (27 May to 31 August). From 1 August the Well Enhancer intervention vessel was consented to work at Gannet F, in the next block. On the quiet setting that pair shows up as one of six Shell alerts for 2019. Press "Example: Gannet, August 2019" to see it.

## Limits

- Locations are licence blocks, not exact positions. Most surveys cross several blocks, but PETS gives only one.
- Dates are consent windows, which are usually wider than the actual work. Survey notifications have no end date, so 30 days is assumed and marked.
- Rigs and vessels are told apart by name, from a hand-made list.
- Joint ventures are mapped by hand (Adura counts for Shell and Equinor).
- This is a demonstration. Alerts are advisory, not a safety system.

## How it's built

- `scripts/fetch_pets.py` downloads the PETS yearly spreadsheets from the UK Energy Portal. There's no direct link, so it drives a headless browser: pick the year, click "Download as Spreadsheet".
- `scripts/xls_to_csv.py` turns each spreadsheet into a tidy CSV in `raw/pets/`. The CSVs are what the repo keeps, so the git history shows exactly what changed and when.
- `scripts/build_data.py` reads those CSVs and the NSTA block layers in `raw/blocks/`, and writes `data/*.json` for the page.
- The page is static (MapLibre GL, OpenFreeMap basemap). All the filtering happens in the browser.

## Daily updates

A GitHub Actions workflow (`.github/workflows/daily-update.yml`) runs every morning shortly after PETS refreshes at 05:00 UK time. It:

1. downloads this year's and last year's spreadsheets (two files);
2. converts them to CSV;
3. rebuilds the data;
4. commits only if something changed. The site then redeploys.

The build keeps `data/tracking.json`, which records when each activity was first seen and when it last changed. `data/changelog.json` lists what was new, changed or removed on each day. The page uses these to show "Data updated" and to filter to alerts involving applications from the last 14 days. Tracking started on 14 November 2026, so anything older counts as "before tracking".

To run it by hand: Actions → "Daily PETS update" → Run workflow. You can also give it specific years. If the download fails, the run keeps a screenshot of the portal page as an artifact called `fetch-debug`.

To rebuild locally:

```
pip install -r scripts/requirements.txt && python -m playwright install chromium
python scripts/fetch_pets.py work/xls 2026 2025
python scripts/xls_to_csv.py work/xls raw/pets
python scripts/build_data.py raw/pets raw/blocks data
```

## Data

- Consent data: OPRED Portal Environmental Tracking System (PETS) public application data, 2019 onwards, checked daily. Contains public sector information licensed under the Open Government Licence v3.0.
- Blocks: North Sea Transition Authority open data.

Built by Rob Dunfey.
