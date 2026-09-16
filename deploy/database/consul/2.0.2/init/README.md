# Consul development data

The Consul development agent starts without ACL authentication. `make db-verify DB=consul@2.0.2` writes and reads the `dbx/smoke` KV value.
