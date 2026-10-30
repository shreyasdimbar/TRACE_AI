/**
 * Transcript normalisation tests.
 *
 * Covers the exporters people actually paste: Zoom, Google Meet, Teams, VTT
 * captions, plain text, and the failure modes (invalid JSON, JSON with no
 * transcript inside) where content must never be dropped.
 *
 *   node test_transcript.js
 */
const { normaliseTranscript, formatStamp } = require('./services/transcriptParser');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `  -> ${detail}` : ''}`);
  }
}

/* ── 1. Zoom-style: wrapped object with start/end seconds ── */
{
  const zoom = JSON.stringify({
    id: 'mtg-1',
    transcript: [
      { speaker: 'Jay Chavan', start: 0, end: 4.2, text: 'Morning everyone' },
      { speaker: 'Ariyan GrandMaster', start: 4.2, end: 9.1, text: 'Lets ship the slack sync today' },
    ],
  });
  const r = normaliseTranscript(zoom);
  check('zoom: detected as json', r.format === 'json', r.format);
  check('zoom: 2 segments', r.segments === 2, r.segments);
  check('zoom: speakers captured', r.speakers.length === 2, JSON.stringify(r.speakers));
  check('zoom: speaker names in text', r.text.includes('Jay Chavan:') && r.text.includes('Ariyan GrandMaster:'));
  check('zoom: timestamps rendered', r.text.includes('[00:00]') && r.text.includes('[00:04]'), r.text);
  check('zoom: no raw braces left', !r.text.includes('{') && !r.text.includes('"speaker"'));
}

/* ── 2. Bare array with alias field names ── */
{
  const arr = JSON.stringify([
    { name: 'Pratap', text: 'the demo is at four' },
    { name: 'Riya', message: 'bringing the laptop charger' },
  ]);
  const r = normaliseTranscript(arr);
  check('array: 2 segments', r.segments === 2, r.segments);
  check('array: alias `message` honoured', r.text.includes('bringing the laptop charger'));
  check('array: alias `name` honoured', r.text.includes('Pratap:'));
}

/* ── 3. Teams export: system events must be dropped ── */
{
  const teams = JSON.stringify({
    messages: [
      { messageType: 'Event', content: 'Pratap joined the meeting' },
      { messageType: 'Message', speaker: 'Pratap Dabhade', content: 'can everyone see my screen', createdDateTime: '2026-10-15T05:30:00Z' },
      { messageType: 'Message', speaker: 'Riya', content: 'yes looks good' },
      { messageType: 'Event', content: 'Recording stopped' },
    ],
  });
  const r = normaliseTranscript(teams);
  check('teams: 2 real messages kept', r.segments === 2, `${r.segments} (events leaked through)`);
  check('teams: event text dropped', !r.text.includes('joined the meeting') && !r.text.includes('Recording stopped'));
  check('teams: iso time rendered as clock time', r.text.includes('[05:30:00]'), r.text);
}

/* ── 4. WebVTT captions ── */
{
  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:04.000
<v Jay>So the deadline is friday

00:00:04.000 --> 00:00:07.500
<v Riya>Confirmed, friday works`;
  const r = normaliseTranscript(vtt);
  check('vtt: detected', r.format === 'vtt', r.format);
  check('vtt: 2 segments', r.segments === 2, r.segments);
  check('vtt: tags stripped', !r.text.includes('<v'));
  check('vtt: speaker kept', r.text.includes('Jay:'));
}

/* ── 5. SRT captions ── */
{
  const srt = `1
00:00:02,500 --> 00:00:05,000
Ship it after review

2
00:00:05,000 --> 00:00:08,000
Agreed`;
  const r = normaliseTranscript(srt);
  check('srt: detected', r.format === 'srt', r.format);
  check('srt: index line dropped', r.text.includes('Ship it after review') && !r.text.includes('\n1\n'));
}

/* ── 6. Plain text passes through unchanged ── */
{
  const text = 'Jay: the release is friday\nRiya: I will prep the notes';
  const r = normaliseTranscript(text);
  check('text: format=text', r.format === 'text', r.format);
  check('text: content untouched', r.text === text);
  check('text: speakers detected from Speaker: lines', r.speakers.length === 2, JSON.stringify(r.speakers));
}

/* ── 7. Failure modes: content must never be lost ── */
{
  const bad = '{ this is not valid json speaker';
  const r = normaliseTranscript(bad);
  check('invalid json: falls back to raw text', r.text === bad && r.format === 'text', r.format);

  const noSeg = JSON.stringify({ foo: 'bar', count: 3 });
  const r2 = normaliseTranscript(noSeg);
  check('unrecognised json: content preserved', r2.text.includes('foo'), r2.text);
  check('unrecognised json: flagged', r2.format === 'json-unrecognised', r2.format);
}

/* ── 8. Timestamp helpers ── */
{
  check('stamp: seconds', formatStamp(65) === '01:05', formatStamp(65));
  check('stamp: iso -> clock time', formatStamp('2026-10-15T00:01:05Z') === '00:01:05', formatStamp('2026-10-15T00:01:05Z'));
  check('stamp: ms integer', formatStamp(120000) === '02:00', formatStamp(120000));
  check('stamp: float seconds', formatStamp(65.5) === '01:05', formatStamp(65.5));
  check('stamp: hms string', formatStamp('01:02:03.000') === '1:02:03', formatStamp('01:02:03.000'));
  check('stamp: missing -> null', formatStamp(undefined) === null);
  check('stamp: garbage -> null', formatStamp('soon') === null);
}

/* ── 9. Edge cases ── */
{
  check('empty: safe', normaliseTranscript('').format === 'empty');
  check('whitespace: safe', normaliseTranscript('   \n  ').format === 'empty');
  check('single object: 1 segment', normaliseTranscript(JSON.stringify({ speaker: 'A', text: 'hi there' })).segments === 1);
  check('words-array: flattened', normaliseTranscript(JSON.stringify([{ speaker: 'A', words: ['hello', { text: 'world' }] }])).text.includes('hello world'));
  const long = normaliseTranscript(JSON.stringify([{ text: 'a'.repeat(10) }, { text: 'b'.repeat(10) }]));
  check('two bare strings: 2 segments', long.segments === 2, long.segments);
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
