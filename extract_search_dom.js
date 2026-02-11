import fs from "node:fs";
import * as cheerio from "cheerio";

const DEBUG_HTML_FILE = "debug_search.html";
const MAX_RESULTS = 30;

// Nordstrom product page paths often look like /s/<slug>/<digits>
function isProductHref(href) {
  if (!href) return false;
  return /^\/s\/.+\/\d+(\?.*)?$/.test(href);
}

function absolutize(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  return `https://www.nordstrom.com${href}`;
}

function normalizeText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function extractPriceFromText(text) {
  const t = normalizeText(text);
  const m = t.match(/\$([0-9]{1,4}(?:\.[0-9]{2})?)/);
  if (!m) return null;
  return m[1].includes(".") ? m[1] : `${m[1]}.00`;
}

function findFirstNordstromImageUrl($root) {
  const img =
    $root.find('img[src*="n.nordstrommedia.com"]').attr("src") ||
    $root.find('img[data-src*="n.nordstrommedia.com"]').attr("data-src") ||
    $root.find('img[srcset*="n.nordstrommedia.com"]').attr("srcset");

  if (!img) return null;

  if (img.includes(" ")) {
    const first = img.split(",")[0].trim().split(" ")[0].trim();
    return first || null;
  }
  return img;
}

function bestTitleFromCard($card, $link) {
  const aria = $link.attr("aria-label");
  if (aria) return normalizeText(aria).replace(/,\s*Image\s*$/i, "");

  const alt = $card.find("img").attr("alt");
  if (alt) return normalizeText(alt).replace(/,\s*Image\s*$/i, "");

  const h =
    $card.find("h2,h3").first().text() ||
    $card.find('[data-testid*="product-title"]').first().text() ||
    $link.text();

  const title = normalizeText(h).replace(/,\s*Image\s*$/i, "");
  return title || null;
}

function extractPriceNearCard($card) {
  // Many Nordstrom search pages don't have visible $ text in the scraped DOM,
  // so this often returns null. That’s okay; we will enrich later from product pages.
  const text = $card.text();
  let p = extractPriceFromText(text);
  if (p) return p;

  const candidates = [
    $card.find('[data-testid*="price"]').text(),
    $card.find("span").text()
  ];

  for (const c of candidates) {
    p = extractPriceFromText(c);
    if (p) return p;
  }

  return null;
}

function findBestCardForLink($link) {
  // Prefer meaningful containers first
  let $card = $link.closest('article,[data-testid*="product"],li').first();
  if (!$card.length) $card = $link.closest("div").first();

  // If the chosen card doesn’t contain a Nordstrom image, climb parents until it does
  let hops = 0;
  while (
    $card.length &&
    !$card.find('img[src*="n.nordstrommedia.com"],img[srcset*="n.nordstrommedia.com"]').length &&
    hops < 6
  ) {
    $card = $card.parent();
    hops++;
  }

  return $card;
}

async function main() {
  if (!fs.existsSync(DEBUG_HTML_FILE)) {
    throw new Error(
      `Missing ${DEBUG_HTML_FILE}. Run the search fetch to generate it first.`
    );
  }

  const html = fs.readFileSync(DEBUG_HTML_FILE, "utf8");
  const $ = cheerio.load(html);

  // Collect product links
  const linkEls = [];
  $('a[href^="/s/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (isProductHref(href)) linkEls.push(el);
  });

  console.error(`[debug] product-like links found: ${linkEls.length}`);

  const seen = new Set();
  const results = [];

  for (const el of linkEls) {
    const $link = $(el);
    const href = $link.attr("href");
    const url = absolutize(href);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const $card = findBestCardForLink($link);

    const title = bestTitleFromCard($card, $link);
    const image = findFirstNordstromImageUrl($card);
    const price = extractPriceNearCard($card);

    // Filter out junk: must have an image OR a meaningful title
    if (!image && !title) continue;

    results.push({
      url,
      title,
      price,
      image
    });

    if (results.length >= MAX_RESULTS) break;
  }

  fs.writeFileSync(
    "search_candidates.json",
    JSON.stringify(results, null, 2),
    "utf8"
  );
  console.error(`[debug] wrote search_candidates.json with ${results.length} items`);

  console.log(JSON.stringify({ count: results.length, results: results.slice(0, 20) }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
