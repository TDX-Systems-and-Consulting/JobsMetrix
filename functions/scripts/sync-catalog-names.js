#!/usr/bin/env node
// Regenerates functions/scopewalk-catalog-names.json and
// functions/scopewalk-catalog-full.json from the live CATALOG_DATA in
// kytrac-app.js. Run this any time catalog items, trades, or names change --
// ScopeWalk's Phase 2 matching goes stale otherwise.
//
// Usage (from repo root): node functions/scripts/sync-catalog-names.js

const fs = require('fs');
const path = require('path');

const appJsPath = path.join(__dirname, '..', '..', 'kytrac-app.js');
const src = fs.readFileSync(appJsPath, 'utf-8');

const marker = 'const CATALOG_DATA = ';
const idx = src.indexOf(marker);
if (idx === -1) throw new Error('Could not find "const CATALOG_DATA = " in kytrac-app.js');
const start = idx + marker.length;

let depth = 0, inStr = false, esc = false, end = null;
for (let i = start; i < src.length; i++) {
  const c = src[i];
  if (inStr) {
    if (esc) esc = false;
    else if (c === '\\') esc = true;
    else if (c === '"') inStr = false;
    continue;
  } else {
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
}
if (end === null) throw new Error('Could not find the end of the CATALOG_DATA object literal');

const CATALOG_DATA = JSON.parse(src.slice(start, end));

const catalogFull = {};
const catalogNames = {};
for (const [trade, items] of Object.entries(CATALOG_DATA)) {
  catalogFull[trade] = items.map(it => ({ name: it.name, materials: it.materials || null, labor: it.labor || null }));
  catalogNames[trade] = items.map(it => it.name);
}

fs.writeFileSync(path.join(__dirname, '..', 'scopewalk-catalog-full.json'), JSON.stringify(catalogFull));
fs.writeFileSync(path.join(__dirname, '..', 'scopewalk-catalog-names.json'), JSON.stringify(catalogNames));

const total = Object.values(catalogNames).reduce((sum, arr) => sum + arr.length, 0);
console.log(`Synced ${total} items across ${Object.keys(catalogNames).length} trades.`);
