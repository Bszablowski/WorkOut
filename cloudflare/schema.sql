-- Baza D1: ten sam model co tabela docs w wersji z PostgreSQL (server/server.js).
CREATE TABLE IF NOT EXISTS docs (
  user_id    TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, doc_id)
);

-- poprzednie wersje dokumentów: zabezpieczenie przed nadpisaniem danych pustym stanem
CREATE TABLE IF NOT EXISTS docs_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  doc_id      TEXT NOT NULL,
  data        TEXT NOT NULL,
  replaced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS docs_history_doc ON docs_history (user_id, doc_id, replaced_at DESC);

-- najwyżej jedna kopia na godzinę dla dokumentu, żeby historia nie zajmowała dziesiątek MB
DROP TRIGGER IF EXISTS docs_keep_old;
CREATE TRIGGER docs_keep_old BEFORE UPDATE ON docs
FOR EACH ROW WHEN OLD.data IS NOT NEW.data AND NOT EXISTS (
  SELECT 1 FROM docs_history h
  WHERE h.user_id = OLD.user_id AND h.doc_id = OLD.doc_id AND h.replaced_at > datetime('now', '-1 hour')
)
BEGIN
  INSERT INTO docs_history (user_id, doc_id, data) VALUES (OLD.user_id, OLD.doc_id, OLD.data);
END;

-- konta użytkowników: hasła jako skrót PBKDF2-SHA256 z losową solą
CREATE TABLE IF NOT EXISTS users (
  name       TEXT PRIMARY KEY,
  salt       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ustawienia serwera (np. losowy klucz do podpisywania sesji)
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- połączenie z kontem Strava (tokeny OAuth) i pobrane aktywności
CREATE TABLE IF NOT EXISTS strava (
  user_id       TEXT PRIMARY KEY,
  athlete_id    INTEGER,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_sync     INTEGER NOT NULL DEFAULT 0,
  cursor        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS activities (
  user_id TEXT    NOT NULL,
  id      INTEGER NOT NULL,
  start   INTEGER NOT NULL,
  data    TEXT    NOT NULL,
  PRIMARY KEY (user_id, id)
);
