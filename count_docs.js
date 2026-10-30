/** Report document counts by source, plus recent Slack docs. Read-only. */
require('dotenv').config();
const mongoose = require('mongoose');
const Document = require('./models/Document');

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });

  const rows = await Document.aggregate([
    { $group: { _id: '$source', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log('  BY SOURCE');
  let total = 0;
  for (const r of rows) {
    console.log('    ' + String(r._id).padEnd(16) + r.n);
    total += r.n;
  }
  console.log('    ' + '-'.repeat(22));
  console.log('    ' + 'TOTAL'.padEnd(16) + total);

  const slack = await Document.find({ source: 'slack' })
    .select('title metadata.channel metadata.sender metadata.messageId')
    .sort({ createdAt: -1 })
    .limit(10);
  console.log('\n  LATEST SLACK DOCS');
  for (const d of slack) {
    console.log('    ' + (d.metadata?.channel || '?').padEnd(13) +
      (d.metadata?.sender || '?').padEnd(18) +
      'ts=' + (d.metadata?.messageId || '?'));
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error('  FAILED: ' + e.message);
  process.exit(1);
});
