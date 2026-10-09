`qrtz.sql` is the unchanged original attachment from DBX issue #11245:

https://github.com/user-attachments/files/33192166/qrtz.sql

SHA256: `d2c42011bbbc1ab8a5429f04cafd4e8756c79e551f38b1563095719f42b1df21`

It creates eleven Quartz tables and five three-column foreign keys. It contains
no `USE`, `DROP`, explicit database names or data modifications. Tests select
their newly created disposable database before executing it; table definitions,
constraint definitions and statement order are preserved.
