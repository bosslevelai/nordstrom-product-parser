import fs from "node:fs";
import * as cheerio from "cheerio";

const DEBUG_HTML_FILE = "debug_search.html";

function absolutize(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `https://www.nordstrom.com${href}`;
  return href;
}

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

async function main() {
  if (!fs.existsSync(DEBUG_HTML_FILE)) {
    throw new Error(`Missing ${DEBUG_HTML_FILE}. Generate it first.`);
  }

  const html = fs.readFileSync(DEBUG_HTML_FILE, "utf8");
  const $ = cheerio.load(html);

  const nextRel =
    $('link[rel="next"]').attr("href") ||
    $('a[rel="next"]').attr("href") ||
    null;

  const pageLinks = [];
  $('a[href*="page="], a[href*="p="], a[href*="offset="]').each((_, el) => {
    const href = $(el).attr("href");
    pageLinks.push(absolutize(href));
  });

  // Sometimes “next” is hidden in JSON inside attributes; also grab anything with sr? and page-ish
  const srLinks = [];
  $('a[href*="/sr"]').each((_, el) => {
    const href = $(el).attr("href");
    const abs = absolutize(href);
    if (abs && /page=|offset=|p=/.test(abs)) srLinks.push(abs);
  });

  console.log(
    JSON.stringify(
      {
        nextRel: absolutize(nextRel),
        pageLinks: uniq(pageLinks).slice(0, 50),
        srPageLinks: uniq(srLinks).slice(0, 50)
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
