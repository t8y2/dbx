# pnpm 10.27.0 global shims

These launchers were captured from a real pnpm 10.27.0 global installation of
`@dbx-app/mcp-server@0.4.71` on Windows. pnpm generated all three files via its
`@pnpm/cmd-shim` dependency.

Only the machine-specific absolute `NODE_PATH` prefix was normalized to
`/pnpm-fixture` (POSIX) or `C:\pnpm-fixture` (Windows). The launcher control
flow and the `$basedir` / `%~dp0` script targets are unchanged.
