# Dashboard Tracker

A live dashboard tracker that syncs from a **published Google Sheet** and serves
a colour-coded status board on **Cloudflare Workers**. Edit the sheet → the board
updates within a few minutes. Nobody hand-paints status colours; they're computed
from the sheet's free-text `Status` column.

```
Google Sheet (published CSV)  →  Worker fetches + caches (~3 min)
                              →  classifies each row into 6 states
                              →  renders the dashboard (HTML + /api/data JSON)
```

## The 6 states

Colour comes from the `Status` text. `Live or Not` is shown as a separate **Live
on Munshot** badge and also promotes a finished/empty status to green.

| State | Colour | Meaning |
|---|---|---|
| Live | 🟢 green | Live on Munshot, nothing outstanding |
| Done — not live | 🔵 blue | Work complete on our side, not yet live |
| In Review / QA | 🟡 yellow | Almost done — sanity check / client feedback |
| In Progress | 🟠 orange | Actively being built, wired, or fixed |
| Blocked / On Hold | 🔴 red | Waiting on client or unresolved |
| Not Started | ⚪ grey | Not started or not assigned |

The keyword → state rules live in `src/classify.js` (`KEYWORDS`). They're plain
string lists — tweak them and re-run `npm test` to see the effect.

## Develop & deploy

```bash
npm install
npm test          # unit tests for parsing + classification
npm run dev       # local preview at http://localhost:8787
npm run deploy    # publish to Cloudflare (needs `wrangler login` once)
```

## Configuration

The published CSV URL is set in `wrangler.toml` under `[vars] CSV_URL`. To point
at a different sheet/tab, republish (File → Share → Publish to web → CSV) and
update that value.

> ⚠️ A published CSV is readable by anyone with the link. To keep the sheet
> private, switch to a Google service-account credential — only the data source
> changes, not this code.

## Data clean-up applied automatically

- Ignores spreadsheet noise (blank rows, repeated header cells, hundreds of
  trailing empty rows).
- Reports **gaps** in the serial sequence (e.g. missing #34, #36) in a banner.
- Fixes recurring typos (`Recieved`→`Received`, `Checklist`, etc.).
- Trims stray whitespace in owner/customer names.
- Recovers the meeting URL when it spilled into an extra column.
- Canonicalises duplicate customer names (e.g. `Vimana` → `Vimana Capital`) via
  `CUSTOMER_ALIASES` in `src/classify.js`.
