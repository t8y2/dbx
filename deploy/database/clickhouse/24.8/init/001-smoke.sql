CREATE TABLE IF NOT EXISTS dbx_smoke (
  id UInt64,
  note String,
  nullable_value Nullable(String),
  created_at DateTime DEFAULT now()
) ENGINE = MergeTree
ORDER BY id;
INSERT INTO dbx_smoke (id, note, nullable_value) VALUES (1, 'DBX smoke 中文 🚀', NULL);
