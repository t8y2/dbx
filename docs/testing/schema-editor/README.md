# Schema editor UI examples

These screenshots render the modified `TableStructureEditor.vue` with fictional
metadata in an isolated browser fixture. `Demo connection`, `demo_db`,
`demo_users`, and all columns, defaults, and indexes are invented examples.
The fixture uses mocked backend APIs, connects to no database, and cannot
execute schema changes.

- `fields.png`: field types, matching default-value colors, and index membership.
- `types.png`: colored options in the field-type dropdown.
- `indexes.png`: primary, unique, ordinary, full-text, and spatial index colors.
- `index-column-picker.png`: searchable composite fields with selection order.
- `index-context-menu.png`: index creation from a field's context menu.

The captures demonstrate frontend presentation and interaction, not live DDL
execution against a database server.
