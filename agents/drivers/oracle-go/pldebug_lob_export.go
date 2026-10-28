package main

import (
	"strconv"
	"strings"
)

func plDebugRenderLobExport(binary bool, value, exported, length, done, left string, bind int) string {
	copy := `        $POS := 1;
        WHILE $POS <= SYS.DBMS_LOB.GETLENGTH($VALUE) AND $LEFT > 0 LOOP
          $CHUNK := SYS.DBMS_LOB.SUBSTR($VALUE, 4096, $POS);
          EXIT WHEN $CHUNK IS NULL;
          $COST := SYS.UTL_RAW.LENGTH(SYS.UTL_I18N.STRING_TO_RAW($CHUNK, 'AL32UTF8'));
          IF $COST IS NULL THEN RAISE_APPLICATION_ERROR(-20000, 'LOB UTF8 conversion failed'); END IF;
          WHILE $COST > $LEFT LOOP
            $CHUNK := SUBSTR($CHUNK, 1, LENGTH($CHUNK) - 1);
            EXIT WHEN $CHUNK IS NULL;
            $COST := SYS.UTL_RAW.LENGTH(SYS.UTL_I18N.STRING_TO_RAW($CHUNK, 'AL32UTF8'));
          END LOOP;
          EXIT WHEN $CHUNK IS NULL;
          SYS.DBMS_LOB.WRITEAPPEND($EXPORT, LENGTH2($CHUNK), $CHUNK);
          $POS := $POS + LENGTH2($CHUNK);
          $LEFT := $LEFT - $COST;
        END LOOP;
        $LENGTH := $POS - 1;
`
	if binary {
		copy = `        $LENGTH := LEAST(SYS.DBMS_LOB.GETLENGTH($VALUE), FLOOR($LEFT / 4) * 3);
        IF $LENGTH > 0 THEN SYS.DBMS_LOB.COPY($EXPORT, $VALUE, $LENGTH); END IF;
        $LEFT := $LEFT - 4 * CEIL($LENGTH / 3);
`
	}
	body := `      IF $VALUE IS NULL THEN $LENGTH := -1; $DONE := 1;
      ELSE
        SYS.DBMS_LOB.CREATETEMPORARY($EXPORT, TRUE, SYS.DBMS_LOB.CALL);
` + copy + `        IF $LENGTH < SYS.DBMS_LOB.GETLENGTH($VALUE) THEN $DONE := 4;
        ELSIF $LENGTH = 0 THEN $DONE := 2; ELSE $DONE := 3; END IF;
      END IF;
      :$BIND := $EXPORT;
`
	return strings.NewReplacer("$VALUE", value, "$EXPORT", exported, "$LENGTH", length, "$DONE", done, "$LEFT", left, "$POS", exported+"_POS", "$CHUNK", exported+"_CH", "$COST", exported+"_COST", "$BIND", strconv.Itoa(bind)).Replace(body)
}

func plDebugRenderRawExport(value, exported, length, done, left string, bind int) string {
	body := `      IF $VALUE IS NULL THEN $LENGTH := -1; $DONE := 1;
      ELSE
        SYS.DBMS_LOB.CREATETEMPORARY($EXPORT, TRUE, SYS.DBMS_LOB.CALL);
        $LENGTH := LEAST(SYS.UTL_RAW.LENGTH($VALUE), FLOOR($LEFT / 4) * 3);
        IF $LENGTH > 0 THEN SYS.DBMS_LOB.WRITEAPPEND($EXPORT, $LENGTH, SYS.UTL_RAW.SUBSTR($VALUE, 1, $LENGTH)); END IF;
        $LEFT := $LEFT - 4 * CEIL($LENGTH / 3);
        IF $LENGTH < SYS.UTL_RAW.LENGTH($VALUE) THEN $DONE := 4; ELSE $DONE := 3; END IF;
      END IF;
      :$BIND := $EXPORT;
`
	return strings.NewReplacer("$VALUE", value, "$EXPORT", exported, "$LENGTH", length, "$DONE", done, "$LEFT", left, "$BIND", strconv.Itoa(bind)).Replace(body)
}
