const SCRAPEDO_TOKEN = process.env.SCRAPEDO_TOKEN;

const JS_URL =
  "https://www.nordstrom.com/static/nordstrom/res/v3/95abab33b97a855a.ml.js";

const MAX_CHARS = 2_000_000; // enough to cover the full file
const MAX_MATCHES = 200;

function buildScrapeDoUrl(url) {
  if (!SCRAPEDO_TOKEN) throw new Error("SCRAPEDO_TOKEN env var missing.");

  const u = new URL("https://api.scrape.do/");
  u.searchParams.set("token", SCRAPEDO_TOKEN);
  u.searchParams.set("url", url);

  // Nordstrom enforced by Scrape.do
  u.searchParams.set("super", "true");
  u.searchParams.set("render", "true");
  u.searchParams.set("blockResources", "true");

  u.searchParams.set("returnJSON", "true");
  u.searchParams.set("waitUntil", "domcontentloaded");
  u.searchParams.set("customWait", "0");
  u.searchParams.set("timeout", "60000");

  return u.toString();
}

async function fetchJs(url) {
  const res = await fetch(buildScrapeDoUrl(url)); // no custom headers
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Scrape.do failed: ${res.status} ${res.statusText}\n${text.slice(0, 300)}`);
  }
  const payload = await res.json();
  const content = payload?.content;
  if (typeof content !== "string") throw new Error("No JS in payload.content");
  return content.slice(0, MAX_CHARS);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function extractMatches(text, re) {
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[0]);
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

async function main() {
  const js = await fetchJs(JS_URL);

  const matches = {
    queryApiFull: extractMatches(
      js,
      /https:\/\/query\.ecommerce\.api\.nordstrom\.com\/[^"'<> ]+/g
    ),
    searchExpApiFull: extractMatches(
      js,
      /https:\/\/search-exp-comp-api\.nordstromaws\.app\/api[^"'<> ]*/g
    ),
    apiNordstromFull: extractMatches(js, /https:\/\/api\.nordstrom\.com\/[^"'<> ]+/g),

    // Common relative patterns that might be appended to those bases
    relativeSearchish: extractMatches(
      js,
      /["']\/(api\/[^"']*search[^"']*|search\/[^"']*|sr\/[^"']*|browse\/[^"']*)["']/gi
    ).map((s) => s.replace(/^["']|["']$/g, "")),

    // Any JSON-ish strings that look like endpoints being constructed
    pathRootHints: extractMatches(
      js,
      /pathRoot["']?\s*:\s*["'][^"']+["']/gi
    ),
    originHints: extractMatches(
      js,
      /origin["']?\s*:\s*["']https:\/\/[^"']+["']/gi
    )
  };

  // De-dupe and trim noisy arrays
  const cleaned = {
    queryApiFull: uniq(matches.queryApiFull).slice(0, 80),
    searchExpApiFull: uniq(matches.searchExpApiFull).slice(0, 80),
    apiNordstromFull: uniq(matches.apiNordstromFull).slice(0, 80),
    relativeSearchish: uniq(matches.relativeSearchish).slice(0, 120),
    pathRootHints: uniq(matches.pathRootHints).slice(0, 40),
    originHints: uniq(matches.originHints).slice(0, 40)
  };

  console.log(JSON.stringify(cleaned, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
