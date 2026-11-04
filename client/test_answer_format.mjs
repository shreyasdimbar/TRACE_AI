import assert from 'node:assert/strict';
import { parseAnswerBlocks } from './src/answerFormat.js';

const answer = `**GreenMart Retail — AI Inventory & Demand Forecasting Platform**

## Current scope
- Centralized multi-store inventory and weekly product/store forecasts, with low-stock alerts. [2]
- Promotional data features and forecast confidence indicators. [5]

## Milestones
- **6 October 2026 — Kickoff:** scheduled. [2]
- **16–20 November 2026 — Client testing:** address confirmed issues before deployment. [5]
- **21 December 2026 — Production deployment.** [5]
- **25 December 2026 — Project closure.** [2, 5]`;

const blocks = parseAnswerBlocks(answer);
assert.equal(blocks[0].type, 'paragraph');
assert.equal(blocks[0].text, '**GreenMart Retail — AI Inventory & Demand Forecasting Platform**');
assert.deepEqual(blocks.filter((block) => block.type === 'heading').map((block) => block.text), [
  'Current scope', 'Milestones',
]);
const lists = blocks.filter((block) => block.type === 'unordered-list');
assert.equal(lists.length, 2);
assert.equal(lists[0].items.length, 2);
assert.equal(lists[1].items.length, 4);
assert.match(lists[1].items[0], /\[2\]$/);
assert.match(lists[1].items[3], /\[2, 5\]$/);

const safe = parseAnswerBlocks('<img src=x onerror=alert(1)>\n\n```js\nconst x = 1;\n```');
assert.equal(safe[0].type, 'paragraph');
assert.equal(safe[0].text, '<img src=x onerror=alert(1)>');
assert.deepEqual(safe[1], { type: 'code', text: 'const x = 1;' });

console.log('PASS  answer formatting keeps headings, lists, citations, and code safe');
