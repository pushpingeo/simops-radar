"""Print a one-line summary of today's changes, for the commit message."""
import json, sys
today = sys.argv[1]
log = json.load(open("data/changelog.json"))
e = log[0] if log and log[0].get("date") == today else None
if e:
    print(f"{len(e['new'])} new, {len(e['changed'])} changed, {len(e['removed'])} removed")
else:
    print("data refreshed")
