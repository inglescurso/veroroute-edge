import type { SearchRequest, SearchResultItem } from "@/types/search";

export async function searchWithFirecrawl(req: SearchRequest, apiKey: string): Promise<SearchResultItem[]> {
  const res = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ query: req.query, limit: req.limit || 5 }),
  });
  if (!res.ok) throw new Error("Firecrawl HTTP " + res.status);
  const data = await res.json() as any;
  return (data.data || data.results || []).map((r: any) => ({
    title: r.title || "Firecrawl Result",
    url: r.url || "",
    content: r.description || r.markdown || r.content || "",
    engine: "firecrawl"
  }));
}

export async function searchWithExa(req: SearchRequest, apiKey: string): Promise<SearchResultItem[]> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ query: req.query, numResults: req.limit || 5, useAutoprompt: true }),
  });
  if (!res.ok) throw new Error("Exa HTTP " + res.status);
  const data = await res.json() as any;
  return (data.results || []).map((r: any) => ({
    title: r.title || "Exa Result",
    url: r.url || "",
    content: r.text || r.snippet || "",
    engine: "exa"
  }));
}

export async function searchWithContext7(req: SearchRequest, apiKey: string): Promise<SearchResultItem[]> {
  const res = await fetch("https://context7.ai/api/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ query: req.query, limit: req.limit || 5 }),
  });
  if (!res.ok) throw new Error("Context7 HTTP " + res.status);
  const data = await res.json() as any;
  return (data.data || data.results || []).map((r: any) => ({
    title: r.title || "Context7 Result",
    url: r.url || "",
    content: r.content || r.snippet || "",
    engine: "context7"
  }));
}

export async function searchWithLinkup(req: SearchRequest, apiKey: string): Promise<SearchResultItem[]> {
  const res = await fetch("https://api.linkup.so/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ q: req.query, depth: "standard", limit: req.limit || 5 }),
  });
  if (!res.ok) throw new Error("Linkup HTTP " + res.status);
  const data = await res.json() as any;
  return (data.results || []).map((r: any) => ({
    title: r.title || r.name || "Linkup Result",
    url: r.url || "",
    content: r.snippet || r.content || "",
    engine: "linkup"
  }));
}

export async function searchWithSearchAPI(req: SearchRequest, apiKey: string): Promise<SearchResultItem[]> {
  const url = new URL("https://www.searchapi.io/api/v1/search");
  url.searchParams.set("q", req.query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("engine", "google");
  
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) throw new Error("SearchAPI HTTP " + res.status);
  const data = await res.json() as any;
  return (data.organic_results || []).map((r: any) => ({
    title: r.title || "SearchAPI Result",
    url: r.link || r.url || "",
    content: r.snippet || "",
    engine: "searchapi"
  }));
}

export async function searchWithYDC(req: SearchRequest, apiKey: string): Promise<SearchResultItem[]> {
  const url = new URL("https://api.ydc-index.io/search");
  url.searchParams.set("query", req.query);
  const res = await fetch(url.toString(), { 
    method: "GET",
    headers: { "X-API-Key": apiKey } 
  });
  if (!res.ok) throw new Error("YDC HTTP " + res.status);
  const data = await res.json() as any;
  return (data.hits || []).map((r: any) => ({
    title: r.title || "YDC Result",
    url: r.url || "",
    content: r.snippets?.join(" ") || r.snippet || "",
    engine: "ydc"
  }));
}
