/**
 * Remove every ingested Slack document, cascading to Chroma and Neo4j.
 *
 * Usage:
 *   node purge_slack.js            # report only, changes nothing
 *   node purge_slack.js --apply    # actually delete
 *
 * Other sources (gmail, google_docs, transcript, manual) are untouched.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Document = require('./models/Document');
const { removeDocument } = require('./services/ingestService');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  const docs = await Document.find({ source: 'slack' }).select('title createdAt');
  console.log(`  slack documents found: ${docs.length}`);

  if (!APPLY) {
    console.log('  DRY RUN - pass --apply to delete.');
    await mongoose.disconnect();
    return;
  }

  let ok = 0;
  for (const d of docs) {
    const removed = await removeDocument(d._id);
    if (removed) ok += 1;
  }

  const remaining = await Document.countDocuments({ source: 'slack' });
  const other = await Document.countDocuments({ source: { $ne: 'slack' } });
  console.log(`  removed        : ${ok}`);
  console.log(`  slack remaining: ${remaining}`);
  console.log(`  other sources  : ${other} (untouched)`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error('  FAILED: ' + err.message);
  process.exit(1);
});
