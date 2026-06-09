-- iOS waitlist signups collected from the landing-page modal (Linear T1-616).
-- One row per email; re-submits are deduped by the UNIQUE constraint.
CREATE TABLE IF NOT EXISTS signups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL UNIQUE,
  consent    INTEGER NOT NULL DEFAULT 1, -- 1 = user ticked the consent box
  source     TEXT,                       -- which CTA opened the modal: header | hero | download_cta
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
