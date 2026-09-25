# Example marketplace catalog

`catalog.example.json` demonstrates the catalog v1 shape. Its checked-in artifact fields are a schema fixture; build an unsigned `hello-workbench` candidate and then run the custom repository signing example to refresh them before using this catalog for an actual Marketplace install.

Serve the `plugins/examples` directory:

```bash
python3 -m http.server 8765 --directory plugins/examples
```

Then add this custom repository in Plugin Center → Settings:

```text
ID: example-marketplace
Name: DBX Example Marketplace
Catalog URL: http://127.0.0.1:8765/marketplace/catalog.example.json
```

The checked-in catalog demonstrates the repository-signed artifact shape, including `signingKeyId`. `node plugins/examples/hello-workbench/package.mjs` always builds an unsigned candidate and does not rewrite the catalog. A custom repository operator then runs `node plugins/examples/hello-workbench/repository-sign.mjs`, which signs the reviewed candidate and refreshes the catalog entry. Add the matching repository public key under Custom repository trust before installing. For a quick unsigned install, use Settings → Install `.dbxp` and explicitly enable the development-package toggle.

Do not reuse an example signing seed for production. Real repositories publish `.dbxp` binaries to release storage and keep only metadata, URLs, SHA-256 values, and review records in the catalog repository.
