-- Disposable synthetic fixtures. Do not replace existing objects.
-- Run postgres-xugu-ui.sql first to create this test schema.
CREATE TABLE dbx_px_ui_261029."DBX_PX_UI_Extended_261030" (
  "id" INTEGER PRIMARY KEY,
  "clock" TIME,
  "instant" TIMESTAMPTZ(6),
  "offset_clock" TIMETZ(3),
  "bits" BIT(8),
  "variable_bits" VARBIT(60000),
  "xml_content" XML,
  "path" JSONPATH,
  "label" NAME,
  "transaction_number" XID,
  "year_month" INTERVAL YEAR TO MONTH,
  "day_time" INTERVAL DAY TO SECOND(6)
);
INSERT INTO dbx_px_ui_261029."DBX_PX_UI_Extended_261030" VALUES
  (1,'12:34:56.123456','2026-03-08 01:59:59.123456-05','12:34:56.123-03:30',B'00000001',B'000101','<a/>text<b/>','$.* ? (@ > 1)','中文_name','4294967295','-1 year -2 months','-2 days -3 hours -4 minutes -5.123456 seconds'),
  (2,'24:00:00','2026-03-08 03:00:00.000001-04','23:59:59.999+14:59',B'11111111',B'','<?xml version="1.0"?><a p="quote''s">\path &amp; x</a>',NULL,'','0','99999999 years 11 months','999999 days 23:59:59.999999'),
  (3,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
  (4,NULL,NULL,'00:00:00-12:59',B'00000000',CAST(repeat('01',30000) AS varbit),NULL,NULL,NULL,NULL,NULL,NULL);
CREATE TABLE dbx_px_ui_261029."DBX_PX_UI_IntervalGeneral_261030" (
  "id" INTEGER PRIMARY KEY,
  "mixed" INTERVAL
);
INSERT INTO dbx_px_ui_261029."DBX_PX_UI_IntervalGeneral_261030" VALUES(1,'1 year 2 months 3 days');
