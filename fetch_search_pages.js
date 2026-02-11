import fs from "node:fs";
import * as cheerio from "cheerio";

const SCRAPEDO_TOKEN = process.env.SCRAPEDO_TOKEN;

// Base search URL (page param will be injected)
const BASE_SEARCH_URL =
  "https://www.nordstrom.com/sr?origin=keywordsearch&keyword=navy%20turtleneck%20sweater&sid=75541";

// Cost control: start small, expand only if needed
const START_PAGES = 2;
const MAX_PAGES = 5;

// Stop once we have this many
const MIN_RESULTS_TARGET = 24;
const MAX_RESULTS_TOTAL = 60;

const OUTPUT_FILE = "search_candidates.json";

function buildScrapeDoUrl(url) {
  if (!SCRAPEDO_TOKEN) throw new Error("SCRAPEDO_TOKEN env var missing.");

  const u = new URL("https://api.scrape.do/");
  u.searchParams.set("token", SCRAPEDO_TOKEN);
  u.searchParams.set("url", url);

  // Per Scrape.do enforcement: Nordstrom requires these
  u.searchParams.set("super", "true");
  u.searchParams.set("render", "true");

  // Keep resources ON so results render
  u.searchParams.set("blockResources", "false");

  // Let page load + settle
  u.searchParams.set("waitUntil", "networkidle2");
  u.searchParams.set("customWait", "2500");
  u.searchParams.set("timeout", "60000");

  u.searchParams.set("returnJSON", "true");
  return u.toString();
}

async function fetchHtml(url) {
  // IMPORTANT: no custom headers for Nordstrom in Scrape.do
  const res = await fetch(buildScrapeDoUrl(url));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Scrape.do failed: ${res.status} ${res.statusText}\n${text.slice(0, 300)}`);
  }
  const payload = await res.json();
  const html = payload?.content;
  if (!html || typeof html !== "string") throw new Error("No HTML found in payload.content");
  return html;
}

function buildPagedUrl(baseUrl, pageNum) {
  const u = new URL(baseUrl);
  u.searchParams.set("page", String(pageNum));
  return u.toString();
}

// ---- DOM extraction ----

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

// Strict + sanity-checked price
function normalizePriceDollars(priceStr) {
  if (!priceStr) return null;
  const m = String(priceStr).match(/\$?\s*([0-9]{1,4}(?:\.[0-9]{2})?)/);
  if (!m) return null;

  const v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return null;

  // sanity checks: kill the 1.00 / 2.00 noise
  if (v < 5 || v > 10000) return null;

  return v.toFixed(2);
}

function extractPriceFromText(text) {
  const t = normalizeText(text);

  // Prefer values that include a '$'
  const withDollar = t.match(/\$([0-9]{1,4}(?:\.[0-9]{2})?)/);
  if (withDollar) return normalizePriceDollars(withDollar[1]);

  // Fall back: still sanity-check
  return normalizePriceDollars(t);
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

  const h = $card.find("h2,h3").first().text() || $link.text();
  return normalizeText(h).replace(/,\s*Image\s*$/i, "") || null;
}

function extractPriceNearCard($card) {
  // Often works, but not always. Still worth trying.
  const text = $card.text();
  let p = extractPriceFromText(text);
  if (p) return p;

  // Try common nodes
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

function findBestCardForLink($, $link) {
  let $card = $link.closest('article,[data-testid*="product"],li').first();
  if (!$card.length) $card = $link.closest("div").first();

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

function extractCandidatesFromHtml(html, { limit = 40 } = {}) {
  const $ = cheerio.load(html);

  const linkEls = [];
  $('a[href^="/s/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (isProductHref(href)) linkEls.push(el);
  });

  const seen = new Set();
  const results = [];

  for (const el of linkEls) {
    const $link = $(el);
    const href = $link.attr("href");
    const url = absolutize(href);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const $card = findBestCardForLink($, $link);
    const title = bestTitleFromCard($card, $link);
    const image = findFirstNordstromImageUrl($card);
    const price = extractPriceNearCard($card);

    if (!image && !title) continue;

    results.push({ url, title, price, image });
    if (results.length >= limit) break;
  }

  return { candidates: results, linkCount: linkEls.length };
}

// ---- main ----

async function main() {
  const all = [];
  const seenGlobal = new Set();

  let pagesFetched = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    // Cost control: fetch first START_PAGES no matter what,
    // then only fetch more if we still need more results.
    if (page > START_PAGES && all.length >= MIN_RESULTS_TARGET) break;

    const url = buildPagedUrl(BASE_SEARCH_URL, page);
    console.error(`[fetch] page ${page}: ${url}`);

    const html = await fetchHtml(url);
    pagesFetched++;

    const { candidates, linkCount } = extractCandidatesFromHtml(html, { limit: 60 });
    console.error(`[parse] page ${page}: product-like links ${linkCount}, extracted ${candidates.length}`);

    for (const c of candidates) {
      if (!c?.url || seenGlobal.has(c.url)) continue;
      seenGlobal.add(c.url);
      all.push(c);
      if (all.length >= MAX_RESULTS_TOTAL) break;
    }

    if (all.length >= MAX_RESULTS_TOTAL) break;
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(all, null, 2), "utf8");
  console.error(`[done] fetched ${pagesFetched} pages, wrote ${OUTPUT_FILE} with ${all.length} unique items`);

  // show a preview
  console.log(JSON.stringify({ count: all.length, preview: all.slice(0, 12) }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
