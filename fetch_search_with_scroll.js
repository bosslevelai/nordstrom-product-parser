import fs from "node:fs";

const SCRAPEDO_TOKEN = process.env.SCRAPEDO_TOKEN;

const TARGET_URL =
  "https://www.nordstrom.com/sr?origin=keywordsearch&keyword=navy%20turtleneck%20sweater&sid=75541";

const SCROLL_STEPS = 10;
const SCROLL_Y = 2200;
const WAIT_MS = 1200;

function buildScrapeDoUrl(url) {
  if (!SCRAPEDO_TOKEN) throw new Error("SCRAPEDO_TOKEN env var missing.");

  const u = new URL("https://api.scrape.do/");
  u.searchParams.set("token", SCRAPEDO_TOKEN);
  u.searchParams.set("url", url);

  // Required for Nordstrom
  u.searchParams.set("super", "true");
  u.searchParams.set("render", "true");
  u.searchParams.set("blockResources", "false");

  u.searchParams.set("waitUntil", "networkidle2");
  u.searchParams.set("customWait", "3000");
  u.searchParams.set("timeout", "60000");
  u.searchParams.set("returnJSON", "true");

  // IMPORTANT: DO NOT encode manually
  const actions = [];
  for (let i = 0; i < SCROLL_STEPS; i++) {
    actions.push({ Action: "ScrollY", Value: SCROLL_Y });
    actions.push({ Action: "Wait", Timeout: WAIT_MS });
  }
  actions.push({ Action: "Wait", Timeout: 2000 });

  // Let URLSearchParams handle encoding
  u.searchParams.set("playWithBrowser", JSON.stringify(actions));

  return u.toString();
}

async function main() {
  const reqUrl = buildScrapeDoUrl(TARGET_URL);

  const res = await fetch(reqUrl); // no custom headers
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Scrape.do failed: ${res.status} ${res.statusText}\n${text.slice(0, 300)}`
    );
  }

  const payload = await res.json();
  const html = payload?.content;

  if (!html || typeof html !== "string") {
    throw new Error("No HTML found in payload.content");
  }

  fs.writeFileSync("debug_search.html", html, "utf8");
  console.error(
    `[debug] wrote debug_search.html (${html.length} chars) after scrolling`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
