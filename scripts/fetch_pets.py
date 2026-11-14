"""Download PETS yearly spreadsheets from the UK Energy Portal.

PETS has no download link of its own: the portal page picks a year with a dropdown that
posts back, then "Download as Spreadsheet" generates the file. So this drives a headless
browser through the same two steps. Once a day, two files, is the intended use.

Usage: python scripts/fetch_pets.py <out folder> [year ...]
       With no years: the current year, plus the previous one (late applications and
       status changes still land in last year's file early in the new year).
On failure it leaves a screenshot and the page HTML in fetch-debug/.
"""
import sys, os, asyncio, datetime
import pandas as pd
from playwright.async_api import async_playwright

URL = os.environ.get("PETS_URL", "https://itportal.energysecurity.gov.uk/eng/fox/beis/PETS_EXTERNAL_PUBLICATION/main")
DEBUG = "fetch-debug"
UA = "SIMOPS-Radar/1.0 (+https://github.com/pushpingeo/simops-radar; daily, two files)"


async def wait_for_year(page, year, timeout=90):
    js = "y => { const s = document.querySelector('select'); return !!s && s.options[s.selectedIndex]?.text === y && document.readyState === 'complete'; }"
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        try:
            await page.wait_for_load_state("domcontentloaded")
            if await page.evaluate(js, str(year)):
                await page.wait_for_timeout(1500)  # let the tables settle before asking for the export
                return
        except Exception:
            pass  # the page is mid-reload
        if asyncio.get_event_loop().time() > deadline:
            raise TimeoutError(f"page never showed year {year}")
        await asyncio.sleep(1)


async def fetch_year(browser, year, out):
    page = await browser.new_page(user_agent=UA, accept_downloads=True)
    try:
        await page.goto(URL, wait_until="domcontentloaded", timeout=90_000)
        select = page.locator("select").first
        await select.wait_for(timeout=60_000)
        current = await select.evaluate("s => s.options[s.selectedIndex]?.text")
        if current != str(year):
            # choosing a year posts the form back; wait until the reloaded page shows that year
            await select.select_option(label=str(year))
            await wait_for_year(page, year)
        chosen = await page.locator("select").first.evaluate("s => s.options[s.selectedIndex]?.text")
        if chosen != str(year):
            raise RuntimeError(f"year dropdown shows {chosen!r}, expected {year}")
        link = page.get_by_text("Download as Spreadsheet", exact=True)
        async with page.expect_download(timeout=180_000) as dl_info:
            await link.click()
        dl = await dl_info.value
        dest = os.path.join(out, f"PETS_Application_Data_{year}.xls")
        await dl.save_as(dest)
        # sanity check: a real export opens and has the Standalone sheet
        sheets = pd.ExcelFile(dest).sheet_names
        if "Standalone" not in sheets:
            raise RuntimeError(f"{dest} has sheets {sheets}, no Standalone")
        print(f"{year}: {os.path.getsize(dest):,} bytes, sheets {sheets}")
    except Exception:
        os.makedirs(DEBUG, exist_ok=True)
        await page.screenshot(path=f"{DEBUG}/{year}.png", full_page=True)
        open(f"{DEBUG}/{year}.html", "w").write(await page.content())
        raise
    finally:
        await page.close()


async def main():
    out = sys.argv[1]
    years = [int(y) for y in sys.argv[2:]] or [datetime.date.today().year, datetime.date.today().year - 1]
    os.makedirs(out, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        failed = []
        for y in years:
            for attempt in (1, 2):
                try:
                    await fetch_year(browser, y, out)
                    break
                except Exception as e:
                    print(f"{y}: attempt {attempt} failed: {e}", file=sys.stderr)
                    if attempt == 2:
                        failed.append(y)
                    else:
                        await asyncio.sleep(20)
        await browser.close()
    if failed:
        sys.exit(f"could not download {failed}")


if __name__ == "__main__":
    asyncio.run(main())
