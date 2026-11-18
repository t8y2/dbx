/** Keep both end groups when possible and use the remaining space for the middle. */
export function connectionGroupPathLabel(segments: readonly string[], fits: (text: string) => boolean): string {
  const fullPath = segments.join("/");
  if (fits(fullPath)) return fullPath;

  const characters = Array.from(fullPath);
  const first = segments.length > 2 ? `${segments[0]}/` : "";
  const last = segments.length > 2 ? `/${segments[segments.length - 1]}` : "";
  const keepEndGroups = !!first && fits(`${first}…${last}`);
  const minHead = keepEndGroups ? Array.from(first).length : 0;
  const minTail = keepEndGroups ? Array.from(last).length : 0;
  let low = minHead + minTail;
  let high = characters.length - 1;
  let result = "…";
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const extra = count - minHead - minTail;
    const head = minHead + Math.ceil(extra / 2);
    const tail = minTail + Math.floor(extra / 2);
    const candidate = `${characters.slice(0, head).join("")}…${tail ? characters.slice(-tail).join("") : ""}`;
    if (fits(candidate)) {
      result = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return result;
}
