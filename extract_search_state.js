import fs from "node:fs";
import * as cheerio from "cheerio";

const DEBUG_HTML_FILE = "debug_search.html";

// Look for these in inline scripts
const MARKERS = [
  "__APOLLO_STATE__",
  "__PRELOADED_STATE__",
  "__INITIAL_STATE__",
  "INITIAL_STATE",
  "preloadedState",
  "apolloState",
  "digitalData",
  "searchResults",
  "products",
  "productResults",
  "searchState",
  "SearchResults"
];

// Extract a JS object that starts at the first '{' after a marker,
// using brace counting (safe, no eval).
function extractObjectByBraceCounting(text, startIdx) {
  const firstBrace = text.indexOf("{", startIdx);
  if (firstBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    } else if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) return text.slice(firstBrace, i + 1);
  }

  return null;
}

function findMarker(text) {
  for (const m of MARKERS) {
    const idx = text.indexOf(m);
    if (idx !== -1) return { marker: m, idx };
  }
  return null;
}

function tryParseJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Heuristic: find arrays of objects that look like products
function findProductArrays(obj) {
  const hits = [];

  function walk(node, path = "") {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === "object" && node[0] !== null) {
        const keys = Object.keys(node[0]).map((k) => k.toLowerCase());
        const looksLikeProduct =
          keys.some((k) => k.includes("price")) &&
          (keys.some((k) => k.includes("name")) || keys.some((k) => k.includes("title"))) &&
          (keys.some((k) => k.includes("image")) ||
            keys.some((k) => k.includes("media")) ||
            keys.some((k) => k.includes("thumbnail")) ||
            keys.some((k) => k.includes("primaryimage")));

        if (looksLikeProduct) {
          hits.push({
            path,
            length: node.length,
            sampleKeys: Object.keys(node[0]).slice(0, 30)
          });
        }
      }
      return;
    }

    for (const [k, v] of Object.entries(node)) {
      walk(v, path ? `${path}.${k}` : k);
    }
  }

  walk(obj, "");
  return hits.slice(0, 25);
}

async function main() {
  if (!fs.existsSync(DEBUG_HTML_FILE)) {
    throw new Error(`Missing ${DEBUG_HTML_FILE}. Generate it first.`);
  }

  const html = fs.readFileSync(DEBUG_HTML_FILE, "utf8");
  const $ = cheerio.load(html);

  const inlineScripts = [];
  $("script:not([src])").each((_, el) => {
    const t = $(el).text();
    if (t && t.length > 2000) inlineScripts.push(t);
  });

  console.error(`[debug] inline scripts >=2k chars: ${inlineScripts.length}`);

  const findings = [];

  for (let i = 0; i < inlineScripts.length; i++) {
    const text = inlineScripts[i];
    const m = findMarker(text);
    if (!m) continue;

    const extracted = extractObjectByBraceCounting(text, m.idx);
    if (!extracted || extracted.length < 20_000) continue; // focus on big blobs

    const parsed = tryParseJSON(extracted);

    if (!parsed) {
      findings.push({
        scriptIndex: i,
        marker: m.marker,
        extractedLength: extracted.length,
        parseableJson: false
      });
      continue;
    }

    const productArrays = findProductArrays(parsed);

    findings.push({
      scriptIndex: i,
      marker: m.marker,
      extractedLength: extracted.length,
      parseableJson: true,
      topKeys: Object.keys(parsed).slice(0, 40),
      productArrays
    });

    if (productArrays.length) break;
  }

  console.log(JSON.stringify({ findings }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

