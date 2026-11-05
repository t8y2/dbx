package main

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode/utf8"
)

const plDebugLegacySourcePage = `DECLARE
 L SYS.DBMS_PREPROCESSOR.SOURCE_LINES_T;
 LI PLS_INTEGER; CP PLS_INTEGER;
 V VARCHAR2(32767); PART VARCHAR2(32767); CHUNK VARCHAR2(32767);
 N PLS_INTEGER; TAKE_N PLS_INTEGER;
BEGIN
 L := SYS.DBMS_PREPROCESSOR.GET_POST_PROCESSED_SOURCE('PACKAGE',:1,:2);
 LI:=:3; CP:=:4;
 WHILE LI <= L.COUNT AND NVL(LENGTH(CHUNK),0) < 1000 LOOP
  V := L(LI);
  IF SUBSTR(V,-1)=CHR(10) THEN V:=SUBSTR(V,1,LENGTH(V)-1); END IF;
  IF SUBSTR(V,-1)=CHR(13) THEN V:=SUBSTR(V,1,LENGTH(V)-1); END IF;
  IF INSTR(V,CHR(10))>0 OR INSTR(V,CHR(13))>0 THEN RAISE_APPLICATION_ERROR(-20994,'source line boundary'); END IF;
  IF LI < L.COUNT THEN V:=V||CHR(10); END IF;
  N:=NVL(LENGTH(V),0);
  IF CP>N+1 THEN RAISE_APPLICATION_ERROR(-20994,'source cursor'); END IF;
  TAKE_N:=LEAST(N-CP+1,1000-NVL(LENGTH(CHUNK),0));
  IF TAKE_N>0 THEN PART:=SUBSTR(V,CP,TAKE_N); CHUNK:=CHUNK||PART; CP:=CP+LENGTH(PART); END IF;
  IF CP>N THEN LI:=LI+1; CP:=1; END IF;
 END LOOP;
 :5:=CHUNK; :6:=LI; :7:=CP; :8:=L.COUNT; :9:=1;
END;`

func plDebugReadLegacyCompiledSource(ctx context.Context, conn *sql.Conn, oci bool, owner, name string) (string, int, error) {
	loader := plDebugNativeTypeLoader{ctx: ctx, conn: conn, oci: oci}
	return loader.compiledSource(owner, name)
}

func (l *plDebugNativeTypeLoader) compiledSource(owner, name string) (string, int, error) {
	line, offset, total, pages := 1, 1, -1, 0
	var source strings.Builder
	for {
		if err := l.ctx.Err(); err != nil {
			return "", pages, err
		}
		if l.bytes >= 1048576 || total < 0 && l.rows >= 8192 {
			return "", pages, errors.New("compiled package source exceeds the remaining metadata budget")
		}
		var chunk sql.NullString
		var ociChunk string
		chunkDestination := any(&chunk)
		if l.oci {
			chunkDestination = &ociChunk
		}
		var nextLine, nextOffset, count, receipt sql.NullInt64
		_, err := l.conn.ExecContext(l.ctx, plDebugLegacySourcePage, quoteIdentifier(owner), quoteIdentifier(name), line, offset,
			plDebugOutArg(l.oci, chunkDestination), plDebugOutArg(l.oci, &nextLine), plDebugOutArg(l.oci, &nextOffset), plDebugOutArg(l.oci, &count), plDebugOutArg(l.oci, &receipt))
		pages++
		if err != nil {
			return "", pages, err
		}
		if err := l.ctx.Err(); err != nil {
			return "", pages, err
		}
		if l.oci {
			chunk = sql.NullString{String: ociChunk, Valid: ociChunk != ""}
		}
		if !receipt.Valid || receipt.Int64 != 1 || !count.Valid || count.Int64 < 1 || count.Int64 > 8192 || !nextLine.Valid || !nextOffset.Valid || nextOffset.Int64 < 1 || nextLine.Int64 < int64(line) || nextLine.Int64 == int64(line) && nextOffset.Int64 <= int64(offset) || nextLine.Int64 > count.Int64+1 || nextLine.Int64 == count.Int64+1 && nextOffset.Int64 != 1 {
			return "", pages, errors.New("compiled package source page is incomplete or its cursor did not advance")
		}
		if total >= 0 && total != int(count.Int64) {
			return "", pages, errors.New("compiled package source line count changed during reading")
		}
		if total < 0 {
			l.rows += int(count.Int64)
			if l.rows > 8192 {
				return "", pages, errors.New("compiled package source exceeds the remaining metadata row budget")
			}
		}
		total = int(count.Int64)
		l.bytes += len(chunk.String)
		if !utf8.ValidString(chunk.String) || utf8.RuneCountInString(chunk.String) > 1000 || l.bytes > 1048576 {
			return "", pages, errors.New("compiled package source text exceeds its metadata budget")
		}
		source.WriteString(chunk.String)
		line, offset = int(nextLine.Int64), int(nextOffset.Int64)
		if line > total {
			return source.String(), pages, nil
		}
	}
}
