# Nordstrom scraping notes (pause point)

## Goal
Support Photographer Style Guide app by matching clothing specs to Nordstrom products.

## Current decision
We are pausing live Nordstrom search scraping for the beta launch.
Reason: Scrape.do requires Super + JS Rendering for Nordstrom and costs are high during build mode.
Plan: launch beta using curated/cached product data and finish the app UX first.

## What works
### Product page parsing
File: nordstrom_test.js
- Uses Scrape.do with super=true + render=true
- Extracts canonical URL, title (og:title), primary image (og:image)
- Extracts price using regex from HTML
- Extracts product image set from nordstrommedia URLs

### Search candidate extraction (limited)
Search pages do not contain __NEXT_DATA__.
We can still extract product candidates from rendered HTML DOM.

File: extract_search_dom.js
- Reads debug_search.html
- Extracts product URLs (/s/.../<id>) + image + title
- Price sometimes present in DOM, sometimes null

### Pagination fetcher
File: fetch_search_pages.js
- Fetches pages 1..5 using page= param
- Each page returns ~4 candidates, total ~20 for the sample query
- Output: search_candidates.json

## Known constraints
- Scrape.do enforces Nordstrom requires super=true and render=true.
- Hobby plan does NOT include Super or JS rendering, so it will not work for Nordstrom.
- Free plan (1000 credits) burns quickly at 25 credits/request.

## Beta approach (next time we resume)
1) Build a curated catalog of products by scraping product pages only (controlled, cached).
2) Match clothing specs against the catalog (local filtering + scoring).
3) Only scrape live search if/when revenue justifies paid Scrape.do tier.

## How to run
### Install deps
npm install cheerio

### Set token
export SCRAPEDO_TOKEN="..."

### Fetch candidates across pages
node fetch_search_pages.js

### Enrich candidates (if file exists)
node enrich_candidates.js
