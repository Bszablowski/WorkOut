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

CREATE TRIGGER IF NOT EXISTS docs_keep_old BEFORE UPDATE ON docs
FOR EACH ROW WHEN OLD.data IS NOT NEW.data
BEGIN
  INSERT INTO docs_history (user_id, doc_id, data) VALUES (OLD.user_id, OLD.doc_id, OLD.data);
END;
