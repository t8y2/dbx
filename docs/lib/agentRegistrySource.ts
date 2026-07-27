import { buildAgentDownloadCatalogFromRegistry, type AgentDownloadCatalog, type AgentRegistry } from "./agentRegistry";

const AGENT_REGISTRY_URLS = ["https://dl.dbxio.com/agents/agent-registry.json", "https://cnb.cool/dbxio.com/dbx/-/releases/download/agents-latest/agent-registry.json"] as const;

function hasDownloadAssets(catalog: AgentDownloadCatalog): boolean {
  return catalog.bundles.length > 0 || catalog.drivers.length > 0 || catalog.jres.length > 0 || catalog.nativeAgents.length > 0;
}

async function fetchRegistry(url: string): Promise<AgentRegistry> {
  const response = await fetch(url, {
    cache: "force-cache",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Download catalog request failed with ${response.status}`);
  return response.json() as Promise<AgentRegistry>;
}

export async function fetchAgentDownloadCatalog(): Promise<AgentDownloadCatalog | null> {
  for (const url of AGENT_REGISTRY_URLS) {
    try {
      const catalog = buildAgentDownloadCatalogFromRegistry(await fetchRegistry(url));
      if (hasDownloadAssets(catalog)) return catalog;
    } catch {
      // Both sources contain the same generated registry; try the synchronized mirror next.
    }
  }

  return null;
}
