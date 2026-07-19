# ZooKeeper 3.9 initialization

The recipe runner creates `/dbx` with a Digest ACL for `root` and password `123456` (or `DB_PASSWORD`). ZooKeeper does not have a global username/password login switch; clients must authenticate with `addauth digest root:<password>` before accessing this protected node.
