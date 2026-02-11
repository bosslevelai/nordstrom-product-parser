import * as cheerio from "cheerio";

const SCRAPEDO_TOKEN = process.env.SCRAPEDO_TOKEN;

// Toggle which URL you want to test
const TARGET_URL =
  "https://www.nordstrom.com/s/pleated-cap-sleeve-charmeuse-gown/8058336";

// Example search URL you shared (keep for testing search pages)
// const TARGET_URL =
//   "https://www.nordstrom.com/sr?origin=keywordsearch&keyword=navy%20turtleneck%20sweater&sid=75541";

/**
 * Build a Scrape.do request URL with configurable cost controls.
 * opts:
 * - super: boolean
 * - render: boolean
 * - blockResources: boolean
 * - waitUntil: "domcontentloaded" | "load" | "networkidle0" | "networkidle2"
 * - customWait: number (ms)
 * - timeout: number (ms)
 */
function buildScrapeDoUrl(url, opts = {}) {
  if (!SCRAPEDO_TOKEN) throw new Error("SCRAPEDO_TOKEN env var missing.");

  const {
    super: superProxy = false,
    render = false,
    blockResources = true,
    waitUntil = "domcontentloaded",
    customWait = 0,
    timeout = 60000
  } = opts;

  const u = new URL("https://api.scrape.do/");
  u.searchParams.set("token", SCRAPEDO_TOKEN);
  u.searchParams.set("url", url);

  // Cost drivers
  u.searchParams.set("super", superProxy ? "true" : "false");
  u.searchParams.set("render", render ? "true" : "false");

  // Cost/speed helper (best ON for search pages; product pages can be ON too)
  u.searchParams.set("blockResources", blockResources ? "true" : "false");

  // Response
  u.searchParams.set("returnJSON", "true");

  // Load behavior
  u.searchParams.set("waitUntil", waitUntil);
  u.searchParams.set("customWait", String(customWait));
  u.searchParams.set("timeout", String(timeout));

  return u.toString();
}

/**
 * Fetch with an escalation ladder:
 * 1) datacenter, no render
 * 2) datacenter + render
 * 3) super, no render
 * 4) super + render
 *
 * We "accept" a page if it returns usable HTML and contains __NEXT_DATA__.
 */
async function fetchWithEscalation(url, { requireNextData = true } = {}) {
  const tiers = [
    {
      name: "T1 datacenter no-render",
      opts: { super: false, render: false, blockResources: true, customWait: 0 }
    },
    {
      name: "T2 datacenter render",
      opts: { super: false, render: true, blockResources: true, customWait: 1000 }
    },
    {
      name: "T3 super no-render",
      opts: { super: true, render: false, blockResources: true, customWait: 0 }
    },
    {
      name: "T4 super render",
      opts: { super: true, render: true, blockResources: true, customWait: 3000 }
    }
  ];

  let lastErr = null;

  for (const tier of tiers) {
    try {
      const reqUrl = buildScrapeDoUrl(url, tier.opts);
      const res = await fetch(reqUrl, { headers: { accept: "application/json" } });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        lastErr = new Error(
          `${tier.name} failed: ${res.status} ${res.statusText}\n${text.slice(
            0,
            250
          )}`
        );
        continue;
      }

      const payload = await res.json();
      const html = payload?.content;

      if (typeof html !== "string" || html.length < 2000) {
        lastErr = new Error(`${tier.name} failed: missing/short HTML`);
        continue;
      }

      if (requireNextData && !html.includes("__NEXT_DATA__")) {
        lastErr = new Error(`${tier.name} failed: missing __NEXT_DATA__`);
        continue;
      }

      return { payload, html, tier: tier.name, tierOpts: tier.opts };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("All tiers failed.");
}

// -------------------- Existing parsing helpers (unchanged) --------------------

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

  if (!u.includes("n.nordstrommedia.com/it/")) return false;
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

  // De-dupe by removing &dpr= variations
  const deduped = new Map();
  for (const img of urls) {
    const base = img.replace(/([?&])dpr=\d+/g, "$1").replace(/[?&]$/, "");
    if (!deduped.has(base)) deduped.set(base, base);
  }

  return Array.from(deduped.values());
}

// -------------------- Main --------------------

async function main() {
  // Require __NEXT_DATA__ for both product pages + search pages
  const { html, tier, tierOpts } = await fetchWithEscalation(TARGET_URL, {
    requireNextData: true
  });

  // Useful for cost estimation + reliability tracking
  console.error(
    `[scrape] success via ${tier} (super=${tierOpts.super}, render=${tierOpts.render}, blockResources=${tierOpts.blockResources})`
  );

  // If this is a product page, this prints product-ish data (same as before)
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
