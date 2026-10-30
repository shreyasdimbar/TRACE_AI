// Authoritative class-coverage check: every className token used in JSX must
// resolve to a selector in index.css. Run: node check_classes.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(e)) out.push(p);
  }
  return out;
}

// --- tokens defined anywhere in the CSS (class selectors, incl. compound) ---
const css = readFileSync(join(SRC, 'index.css'), 'utf8');
const defined = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) defined.add(m[1]);

// --- tokens used in JSX, from every className form we actually ship ---
const used = new Map(); // token -> first file:line
const files = walk(SRC);
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const re = /className\s*=\s*(?:"([^"]*)"|{`([^`]*)`}|'([^']*)')/g;
    for (const m of line.matchAll(re)) {
      const raw = m[1] ?? m[2] ?? m[3] ?? '';
      for (let t of raw.split(/\s+/)) {
        // strip JSX conditional fragments: {cond && 'foo'}, ternaries, ${}
        t = t.replace(/^\{|\}$/g, '');
        if (!t || /[{}$()?:&|]/.test(t)) continue;
        if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(t) && !used.has(t)) {
          used.set(t, `${f.replace(SRC, 'src')}:${i + 1}`);
        }
      }
    }
  });
}

const missing = [...used.keys()].filter((c) => !defined.has(c)).sort();
console.log(`  files scanned        : ${files.length}`);
console.log(`  classes used in JSX  : ${used.size}`);
console.log(`  classes in CSS       : ${defined.size}`);
console.log(`  MISSING              : ${missing.length}`);
for (const c of missing) console.log(`     *** ${c}  <- ${used.get(c)}`);
process.exit(missing.length ? 1 : 0);
