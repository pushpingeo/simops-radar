-- SIMOPS Radar sign-ups and feedback (Cloudflare D1)
CREATE TABLE IF NOT EXISTS signups (
  email      TEXT PRIMARY KEY,
  operator   TEXT,
  watching   TEXT,
  settings   TEXT,      -- the page link with the rules they had set
  created    TEXT NOT NULL,
  updated    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created    TEXT NOT NULL,
  email      TEXT,      -- optional, only if they want a reply
  body       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hits (
  who        TEXT NOT NULL,   -- salted hash of the IP, used only for rate limiting
  day        TEXT NOT NULL,
  n          INTEGER NOT NULL,
  PRIMARY KEY (who, day)
);
