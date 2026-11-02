import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));
await rm(distDirectory, { recursive: true, force: true });
