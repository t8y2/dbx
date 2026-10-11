import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeContributorSnapshot(outputPath, snapshot) {
  try {
    const previous = JSON.parse(await readFile(outputPath, "utf8"));
    if (JSON.stringify({ ...previous, generatedAt: snapshot.generatedAt }) === JSON.stringify(snapshot)) return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return true;
}
