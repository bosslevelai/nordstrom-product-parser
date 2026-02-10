import * as cheerio from "cheerio";

const SCRAPEDO_TOKEN = process.env.SCRAPEDO_TOKEN;
const TARGET_URL =
  "https://www.nordstrom.com/s/pleated-cap-sleeve-charmeuse-gown/8058336";

function buildScrapeDoUrl(url) {
  const u = new URL("https://api.scrape.do/");
  u.searchParams.set("token", SCRAPEDO_TOKEN);
  u.searchParams.set("url", url);

  // Working toggles from your Scrape.do Playground
  u.searchParams.set("super", "true");
  u.searchParams.set("render", "true");

  // Leave false while validating price + images.
  // Once stable, you can turn this back to true to reduce cost.
  u.searchParams.set("blockResources", "false");

  u.searchParams.set("returnJSON", "true");
  u.searchParams.set("waitUntil", "domcontentloaded");
  u.searchParams.set("customWait", "6000");
  u.searchParams.set("timeout", "60000");

  return u.toString();
}

async function fetchPayload(url) {
  const res = await fetch(buildScrapeDoUrl(url), {
    headers: { accept: "application/json" }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Scrape.do failed: ${res.status} ${res.statusText}\n${text.slice(0, 300)}`
    );
  }

  return await res.json();
}

function normalizeText(s) {
  return (s || "").replace(/\s+/g, " ").trim() || null;
}

function normalizePrice(value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  const m = s.match(/([0-9]+(?:\.[0-9]{2})?)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return null;
  if (v < 5 || v > 10000) return null;
  return v.toFixed(2);
}

function tryPriceFromHtmlRegex(html) {
  const patterns = [
    /"currentPrice"\s*:\s*"?([0-9]+(?:\.[0-9]{2})?)"?/i,
    /"salePrice"\s*:\s*"?([0-9]+(?:\.[0-9]{2})?)"?/i,
    /"originalPrice"\s*:\s*"?([0-9]+(?:\.[0-9]{2})?)"?/i,
    /"price"\s*:\s*"?([0-9]+(?:\.[0-9]{2})?)"?/i
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const p = normalizePrice(m[1]);
      if (p) return p;
    }
  }
  return null;
}

function parseMetaFromHtml(html) {
  const $ = cheerio.load(html);

  const canonical = $('link[rel="canonical"]').attr("href") || null;
  const ogTitle = $('meta[property="og:title"]').attr("content") || null;
  const ogImage = $('meta[property="og:image"]').attr("content") || null;

  const title = normalizeText(ogTitle) || normalizeText($("title").text());
  return { canonical, title, ogImage };
}

function decodeHtmlEntities(url) {
  return url.replace(/&amp;/g, "&");
}

function isLikelyProductImage(url) {
  const u = url.toLowerCase();

  // Must be Nordstrom product image host + path
  if (!u.includes("n.nordstrommedia.com/it/")) return false;

  // Exclude non-product assets
  if (u.includes("nordstrom-logo")) return false;
  if (u.endsWith(".svg") || u.endsWith(".gif")) return false;

  // Exclude tiny thumbnails
  if (u.includes("crop=pad") && (u.includes("w=60") || u.includes("h=90"))) return false;

  return true;
}

function extractProductImages(html) {
  const urls = new Set();
  const re = /https:\/\/n\.nordstrommedia\.com\/[^"' )]+/g;

  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = decodeHtmlEntities(m[0]);
    if (isLikelyProductImage(raw)) {
      urls.add(raw);
      if (urls.size > 50) break;
    }
  }

  // De-dupe by removing &dpr= variations (keep one per base URL)
  const deduped = new Map();
  for (const img of urls) {
    const base = img.replace(/([?&])dpr=\d+/g, "$1").replace(/[?&]$/, "");
    if (!deduped.has(base)) deduped.set(base, base);
  }

  return Array.from(deduped.values());
}

async function main() {
  if (!SCRAPEDO_TOKEN) throw new Error("SCRAPEDO_TOKEN env var missing.");

  const payload = await fetchPayload(TARGET_URL);
  const html = payload?.content;

  if (!html || typeof html !== "string") {
    throw new Error("No HTML found in payload.content");
  }

  const { canonical, title, ogImage } = parseMetaFromHtml(html);
  const price = tryPriceFromHtmlRegex(html);

  const productImages = extractProductImages(html);

  const primaryImage = ogImage ? decodeHtmlEntities(ogImage) : null;
  const productImagesFinal = Array.from(
    new Set([primaryImage, ...productImages].filter(Boolean))
  );

  console.log(
    JSON.stringify(
      {
        url: canonical || TARGET_URL,
        title,
        price,
        primaryImage,
        productImages: productImagesFinal
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
