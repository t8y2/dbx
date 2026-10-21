# Navicat MySQL HTTP Tunnel

DBX supports Navicat's MySQL HTTP tunnel protocol. DBX does not include or
modify PremiumSoft's proprietary `ntunnel_mysql.php` script. Navicat documents
that the original script is supplied in its installation folder/package on
Windows and can be exported from the HTTP tab on macOS and Linux:
https://help.navicat.com/hc/en-us/articles/218283457-Where-can-I-get-the-HTTP-tunnel-script-file

The Navicat EULA restricts copying, modification, and distribution except as
expressly allowed by its terms. Obtain the script from an authorized Navicat
distribution and follow the EULA for your edition:
https://www.navicat.com/manual/pdf_manual/en/navicat_17/win_manual/navicat_en.pdf

The separate `deploy/dbx_tunnel.php` file is DBX's own tunnel and is not a
Navicat-compatible endpoint.

Upload your authorized copy of `ntunnel_mysql.php` to the PHP host and configure
DBX with its full URL, such as `https://db.example.com/ntunnel_mysql.php`. Plain
HTTP is accepted for trusted private networks, but it exposes database
credentials and SQL in transit. If the endpoint redirects HTTP to HTTPS,
configure DBX with the final HTTPS URL; redirects are not followed because they
can change a POST request into a GET.

This protocol supports regular queries, `USE`, ping, and disconnect. MySQL TLS
and prepared statements are not supported by the Navicat HTTP tunnel protocol.
Each HTTP request opens a separate MySQL session, so this endpoint is appropriate
only for non-transactional operations and backups that do not request a consistent
snapshot. Transactions, savepoints, autocommit settings, and consistent-snapshot
backup sequences are rejected before any SQL is sent to the PHP host; this prevents
a successful-looking `ROLLBACK` from failing to undo a write that ran in another
session.

For transaction workflows or backups that require a consistent snapshot, deploy
DBX's own `deploy/dbx_tunnel.php` endpoint instead. That endpoint keeps one
database TCP session alive for the lifetime of the tunnel and is configured as the
DBX TCP HTTP tunnel, not as the Navicat-compatible endpoint.
