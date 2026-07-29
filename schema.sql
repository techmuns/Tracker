-- Commit-tracking storage for the Tracker Performance view.
-- Apply with:  npx wrangler d1 execute tracker_commits --remote --file schema.sql
-- (drop --remote to seed your local dev DB instead)

CREATE TABLE IF NOT EXISTS commits (
  sha          TEXT PRIMARY KEY,   -- GitHub commit SHA (dedupes re-polls/webhooks)
  repo         TEXT NOT NULL,      -- owner/repo
  dashboard_id TEXT,               -- tracker dashboard this repo maps to ('' if unknown)
  author       TEXT,
  message      TEXT,               -- first line of the commit message
  ts           INTEGER NOT NULL,   -- author date, epoch ms
  day          TEXT NOT NULL       -- YYYY-MM-DD in IST
);
CREATE INDEX IF NOT EXISTS idx_commits_repo_day ON commits(repo, day);
CREATE INDEX IF NOT EXISTS idx_commits_dash_day ON commits(dashboard_id, day);
CREATE INDEX IF NOT EXISTS idx_commits_day      ON commits(day);

-- One AI summary per repo per day (what happened that day, in plain English).
CREATE TABLE IF NOT EXISTS daily_summary (
  repo       TEXT NOT NULL,
  day        TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  summary    TEXT,
  updated_at INTEGER,
  PRIMARY KEY (repo, day)
);

-- Bookkeeping for the incremental poll (how far back to fetch next time).
CREATE TABLE IF NOT EXISTS poll_state (
  repo        TEXT PRIMARY KEY,
  last_polled INTEGER
);
