-- Synthetic fixture only. Run in a disposable PostgreSQL test database.
-- This script intentionally does not drop or replace existing objects.
CREATE SCHEMA dbx_px_ui_261029;
CREATE TABLE dbx_px_ui_261029."DBX_PX_UI_Mixed_261029" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" VARCHAR(100) NOT NULL DEFAULT 'fixture',
  "amount" NUMERIC(38,6),
  "flag" BOOLEAN,
  "payload" TEXT,
  "binary" BYTEA,
  "event_date" DATE,
  "event_time" TIME(3),
  "event_at" TIMESTAMP(6),
  "document" JSONB,
  "uuid" UUID
);
COMMENT ON TABLE dbx_px_ui_261029."DBX_PX_UI_Mixed_261029" IS 'Synthetic PostgreSQL to Xugu UI fixture';
COMMENT ON COLUMN dbx_px_ui_261029."DBX_PX_UI_Mixed_261029"."amount" IS 'Exact 38-digit decimal';
INSERT INTO dbx_px_ui_261029."DBX_PX_UI_Mixed_261029"
  ("name","amount","flag","payload","binary","event_date","event_time","event_at","document","uuid")
VALUES
  ('quote''s \path',12345678901234567890123456789012.123456,true,'中文\path' || chr(10),decode('00017fff','hex'),'2026-02-03','04:05:06.123','2026-02-03 04:05:06.123456','{"number":123456789012345678901234567890,"text":"a\\b"}','123e4567-e89b-12d3-a456-426614174000'),
  ('empty',0,false,'',decode('','hex'),'2000-02-29','00:00:00','2000-02-29 00:00:00','null','00000000-0000-0000-0000-000000000000'),
  ('null',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
  ('large',-0.000001,true,repeat('Large text ',16000),decode(repeat('00ff',70000),'hex'),'9999-12-31','23:59:59.999','9999-12-31 23:59:59.999999','{"array":[true,null,1]}','ffffffff-ffff-ffff-ffff-ffffffffffff');
CREATE TABLE dbx_px_ui_261029."DBX_PX_UI_Rows_261029" ("id" INTEGER PRIMARY KEY,"name" VARCHAR(100),"payload" TEXT);
INSERT INTO dbx_px_ui_261029."DBX_PX_UI_Rows_261029" SELECT g,'row-'||g,repeat('payload-',20) FROM generate_series(1,12007) g;
CREATE TABLE dbx_px_ui_261029."DBX_PX_UI_Empty_261029" ("id" INTEGER PRIMARY KEY,"name" VARCHAR(100));
CREATE TABLE dbx_px_ui_261029."DBX_PX_UI_Array_261029" ("id" INTEGER PRIMARY KEY,"values" INTEGER[]);
INSERT INTO dbx_px_ui_261029."DBX_PX_UI_Array_261029" VALUES (1,ARRAY[1,NULL,3]);
CREATE VIEW dbx_px_ui_261029."DBX_PX_UI_View_261029" AS SELECT "id","name" FROM dbx_px_ui_261029."DBX_PX_UI_Mixed_261029";
