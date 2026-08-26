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

### Commit summaries (LLM)

The daily commit digest is written by **Claude via Amazon Bedrock**, with
**OpenAI as an automatic fallback**. Bedrock is used whenever `BEDROCK_API_KEY`
is present; any Bedrock failure — missing key, a 403, throttling, a timeout —
falls through to OpenAI, and if neither answers the digest degrades to the raw
commit messages as bullets. Nothing about the prompts or the output format
changes between providers.

| Setting | Kind | Purpose |
|---|---|---|
| `BEDROCK_API_KEY` | secret | Bedrock API key. Sent as a bearer token in the `x-api-key` header. |
| `OPENAI_API_KEY` | secret | Fallback provider. |
| `BEDROCK_REGION` | var | Region in the endpoint host. Defaults to `us-east-1`. |
| `LLM_PROVIDER` | var | `openai` forces the old path back; `bedrock` pins Bedrock. Unset = auto. |
| `BEDROCK_MODEL` | var | Pin one model instead of using the fallback chain. |

Calls go to `https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages` with
`anthropic-version: 2023-06-01` — plain `fetch`, no AWS SDK and no SigV4
signing. Model IDs carry an `anthropic.` prefix, and because Bedrock grants
Opus 5 per-account, the Worker tries `anthropic.claude-opus-5` →
`anthropic.claude-opus-4-8` → `anthropic.claude-sonnet-5` and remembers the
first that answers.

**The key stays server-side.** Every Bedrock call happens inside the Worker; the
browser only ever talks to this Worker's own routes, and no response includes
the key or any part of it.

Check the key without triggering any real work:

```bash
curl https://tracker.tech-441.workers.dev/api/health/llm
# add  -H "x-edit-token: <EDIT_TOKEN>"  if you've set an edit token
```

It makes one cheap structured call and reports which provider and model
answered, plus which structured-output mode this deployment accepts.

**Local `wrangler dev`:** secrets set in the Cloudflare dashboard are *not*
available locally. Put them in a `.dev.vars` file in the project root (already
gitignored):

```
BEDROCK_API_KEY="..."
OPENAI_API_KEY="..."
```

`BEDROCK_REGION` comes from `wrangler.toml`, so it works locally as-is. No
`nodejs_compat` flag is needed — the Bedrock path uses only `fetch`, `URL`,
`JSON` and `AbortController`, all Workers built-ins.

## Data clean-up applied automatically

- Ignores spreadsheet noise (blank rows, repeated header cells, hundreds of
  trailing empty rows).
- Reports **gaps** in the serial sequence (e.g. missing #34, #36) in a banner.
- Fixes recurring typos (`Recieved`→`Received`, `Checklist`, etc.).
- Trims stray whitespace in owner/customer names.
- Recovers the meeting URL when it spilled into an extra column.
- Canonicalises duplicate customer names (e.g. `Vimana` → `Vimana Capital`) via
  `CUSTOMER_ALIASES` in `src/classify.js`.
