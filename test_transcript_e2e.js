/**
 * End-to-end transcript ingest test.
 *
 * Proves the API accepts a JSON export (not just plain text), flattens it to
 * speaker lines before storage, and records the format in metadata. Requires
 * the API on :5000.
 *
 *   node test_transcript_e2e.js
 */
const API = process.env.API_URL || 'http://localhost:5000';
const EMAIL = process.env.SUITE_EMAIL || 'auth.suite@walchandsangli.ac.in';
const PASSWORD = process.env.SUITE_PASSWORD || 'Suite@12345';

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? `  -> ${detail}` : ''}`); }
}

const ZOOM_JSON = JSON.stringify({
  id: 'sprint-review-14',
  transcript: [
    { speaker: 'Jay Chavan', start: 0, end: 5.1, text: 'Sprint review, lets start with the slack integration' },
    { speaker: 'Ariyan GrandMaster', start: 5.1, end: 11.4, text: 'The sync now deduplicates on message ts so re-running is safe' },
    { speaker: 'Jay Chavan', start: 11.4, end: 16.0, text: 'Good, ship it before the presentation at four' },
  ],
});

(async () => {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json());
  if (!login.token) { console.error('  login failed: ' + JSON.stringify(login)); process.exit(1); }
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };

  const title = `E2E transcript ${Date.now()}`;
  const res = await fetch(`${API}/api/ingest`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ source: 'transcript', title, content: ZOOM_JSON }),
  });
  const body = await res.json();
  check('api: accepted json transcript', res.status === 201 || res.status === 200, `${res.status} ${JSON.stringify(body)}`);
  check('api: reported format json', body.transcript?.format === 'json', JSON.stringify(body.transcript));
  check('api: reported 3 segments', body.transcript?.segments === 3, JSON.stringify(body.transcript));
  check('api: reported speakers', body.transcript?.speakers?.length === 2, JSON.stringify(body.transcript?.speakers));

  // Fetch the stored document back and inspect what actually got persisted.
  const doc = await fetch(`${API}/api/documents?source=transcript&limit=50`, { headers: auth }).then((r) => r.json());
  const stored = (doc.documents || []).find((d) => d.title === title);
  check('stored: document exists', Boolean(stored), `among ${(doc.documents || []).length} transcripts`);

  if (stored) {
    const raw = stored.rawContent || '';
    check('stored: no json braces', !raw.includes('{') && !raw.includes('"speaker"'), raw.slice(0, 120));
    check('stored: speaker labels present', raw.includes('Jay Chavan:') && raw.includes('Ariyan GrandMaster:'), raw.slice(0, 160));
    check('stored: timestamps present', raw.includes('[00:00]') && raw.includes('[00:05]'), raw.slice(0, 160));
    check('stored: metadata format kept', stored.metadata?.transcriptFormat === 'json', JSON.stringify(stored.metadata));
    check('stored: metadata speakers kept', Array.isArray(stored.metadata?.participants) && stored.metadata.participants.length === 2, JSON.stringify(stored.metadata?.participants));
    check('stored: metadata segment count kept', stored.metadata?.transcriptSegments === 3, JSON.stringify(stored.metadata));
    check('stored: flattened is shorter than the json', raw.length < ZOOM_JSON.length, `${raw.length} vs ${ZOOM_JSON.length}`);

    // Cleanup so repeated runs do not litter the demo corpus.
    await fetch(`${API}/api/documents/${stored._id}`, { method: 'DELETE', headers: auth });
    const after = await fetch(`${API}/api/documents?source=transcript&limit=50`, { headers: auth }).then((r) => r.json());
    check('cleanup: document removed', !(after.documents || []).some((d) => d.title === title));
  }

  // Plain text must still pass through untouched -- the new normaliser must not
  // regress the original behaviour.
  const plainTitle = `E2E plain transcript ${Date.now()}`;
  const plainText = 'Jay: deploy is at five\nRiya: I will watch the logs';
  const plainRes = await fetch(`${API}/api/ingest`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ source: 'transcript', title: plainTitle, content: plainText }),
  }).then((r) => r.json());
  check('plain: format detected as text', plainRes.transcript?.format === 'text', JSON.stringify(plainRes.transcript));

  const list2 = await fetch(`${API}/api/documents?source=transcript&limit=50`, { headers: auth }).then((r) => r.json());
  const plainStored = (list2.documents || []).find((d) => d.title === plainTitle);
  check('plain: content untouched', plainStored?.rawContent === plainText, JSON.stringify(plainStored?.rawContent));
  if (plainStored) await fetch(`${API}/api/documents/${plainStored._id}`, { method: 'DELETE', headers: auth });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('  FAILED: ' + e.message);
  process.exit(1);
});
