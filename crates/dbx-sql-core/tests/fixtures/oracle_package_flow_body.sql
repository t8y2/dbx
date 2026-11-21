CREATE OR REPLACE PACKAGE BODY PKG_FLOW AS
  FUNCTION step(x NUMBER) RETURN NUMBER IS
  BEGIN RETURN x + g_bias; END step;
  FUNCTION score(p NUMBER) RETURN NUMBER IS
    total NUMBER := 0;
    e_negative EXCEPTION;
  BEGIN
    IF p < 0 THEN RAISE e_negative;
    ELSIF p = 0 THEN RETURN step(0);
    ELSE
      FOR i IN 1..3 LOOP
        IF i = 2 THEN CONTINUE; END IF;
        total := total + step(i);
      END LOOP;
    END IF;
    WHILE total < 10 LOOP
      total := step(total);
      EXIT WHEN total >= 10;
    END LOOP;
    LOOP EXIT WHEN total >= 12; total := step(total); END LOOP;
    DECLARE total NUMBER := step(1);
    BEGIN
      IF total > 0 THEN total := step(total); END IF;
    EXCEPTION WHEN VALUE_ERROR THEN total := step(0);
    END;
    RETURN step(total);
  EXCEPTION
    WHEN e_negative THEN RETURN step(-p);
    WHEN OTHERS THEN RAISE;
  END score;
END PKG_FLOW;
