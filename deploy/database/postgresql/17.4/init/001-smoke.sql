CREATE TABLE IF NOT EXISTS dbx_smoke (
  id BIGSERIAL PRIMARY KEY,
  note TEXT NOT NULL,
  nullable_value TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dbx_smoke_note ON dbx_smoke (note);
INSERT INTO dbx_smoke (note, nullable_value) VALUES ('DBX smoke 中文 🚀', NULL);
