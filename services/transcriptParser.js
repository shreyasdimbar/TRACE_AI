/**
 * Transcript normalisation.
 *
 * The ingest path used to store whatever was pasted verbatim, so a JSON export
 * from Zoom/Meet/Teams was stored as one opaque blob: it embedded badly (the
 * vector was mostly punctuation and field names) and could not be searched by
 * speaker. This turns both plain text and JSON into the same readable shape:
 *
 *     [00:12] Jay Chavan: let's ship friday
 *     [00:31] Ariyan GrandMaster: agreed
 *
 * Detection is structural, not filename-based, because callers paste content
 * into a textarea. Anything that is not recognisable JSON is treated as plain
 * text and returned unchanged -- the caller never loses data.
 */

/** Field aliases across the common exporters. */
const SPEAKER_KEYS = ['speaker', 'speaker_name', 'speakerName', 'name', 'author', 'sender', 'user', 'participant', 'from', 'displayName', 'display_name'];
const TEXT_KEYS = ['text', 'content', 'message', 'transcript', 'speech', 'body', 'caption', 'sentence', 'value', 'words'];
const START_KEYS = ['start', 'start_time', 'startTime', 'startOffset', 'start_offset', 'offset', 'begin', 't', 'time', 'createdDateTime', 'created_at'];
/** Wrappers some exporters put the segment array under. */
const CONTAINER_KEYS = ['transcript', 'segments', 'messages', 'chunks', 'entries', 'data', 'results', 'items', 'utterances', 'lines', 'words', 'events'];
/** Teams marks system events separately; including them would pollute search. */
const SKIP_TYPE_KEYS = ['messageType', 'MessageType', 'event', 'type'];

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    // Numbers are accepted too: timestamps are commonly numeric (`start: 0`),
    // and a string-only matcher silently dropped every one of them.
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Numeric seconds-vs-milliseconds heuristic.
 *
 * Fractional values are durations in seconds (Zoom emits float seconds). Large
 * integers are milliseconds -- a transcript spanning 1e5 seconds is 27 hours,
 * which does not occur, so `120000` means two minutes, not a day and a half.
 */
function toSeconds(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (!Number.isInteger(n)) return n;
  return n >= 10000 ? n / 1000 : n;
}

/** Seconds, ms, "HH:MM:SS.mmm", or ISO timestamp -> "MM:SS" / "H:MM:SS". */
function formatStamp(raw) {
  if (raw == null || raw === '') return null;

  // Absolute moments (Teams/Meet emit ISO-8601) render as clock time. Reducing
  // an epoch to a duration produced things like "497789:30:00", which tells a
  // reader nothing.
  if (typeof raw === 'string' && !/^[\d:.]+$/.test(raw.trim())) {
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) return null;
    const d = new Date(parsed);
    return (
      `${String(d.getUTCHours()).padStart(2, '0')}:` +
      `${String(d.getUTCMinutes()).padStart(2, '0')}:` +
      `${String(d.getUTCSeconds()).padStart(2, '0')}`
    );
  }

  let seconds = null;

  if (typeof raw === 'number') {
    seconds = toSeconds(raw);
  } else {
    const s = String(raw).trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      seconds = toSeconds(Number(s));
    } else if (/^\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?$/.test(s)) {
      const parts = s.replace(',', '.').split(':').map(Number);
      seconds = parts.reduce((acc, p) => acc * 60 + p, 0);
    }
  }

  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Flatten `words`-style payloads ("a b c") that some ASR exports use. */
function flattenWords(v) {
  if (!Array.isArray(v)) return typeof v === 'string' ? v : '';
  return v.map((w) => (typeof w === 'string' ? w : w?.text || w?.word || '')).filter(Boolean).join(' ');
}

function normaliseSegments(list) {
  const segments = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      // A bare string in the array is still a spoken line.
      if (typeof item === 'string' && item.trim()) segments.push({ speaker: null, start: null, text: item.trim() });
      continue;
    }

    // Skip Teams/Zoom system events ("call started", "recording stopped").
    const skipType = SKIP_TYPE_KEYS.map((k) => item[k]).find((v) => typeof v === 'string');
    if (skipType && !/^(message|speech|user|chat)$/i.test(skipType)) continue;

    let text = pick(item, TEXT_KEYS);
    if (!text && item.words) text = flattenWords(item.words);
    if (!text) continue;

    segments.push({
      speaker: pick(item, SPEAKER_KEYS),
      start: formatStamp(pick(item, START_KEYS)),
      text: text.replace(/\s+/g, ' ').trim(),
    });
  }
  return segments;
}

/** WebVTT / SRT captions -> the same `[MM:SS] Speaker: text` lines. */
function parseCaptions(raw) {
  if (!/^WEBVTT|^Kind:|^Language:/im.test(raw) && !/\d{2}:\d{2}(:\d{2})?[,.]\d{3}\s*-->/m.test(raw)) return null;
  const lines = [];
  const blocks = raw.replace(/\r/g, '').split(/\n\s*\n/);
  for (const block of blocks) {
    const rows = block
      .split('\n')
      .filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^WEBVTT|^Kind:|^Language:|^NOTE/i.test(l));
    if (!rows.length) continue;

    const stamp = block.match(/(\d{2}:\d{2}(?::\d{2})?[.,]\d{3})\s*-->/);
    // WebVTT marks the speaker with a voice tag (`<v Jay>text`). Without this
    // the speaker is lost, because the tag has no colon for the label regex.
    const voice = block.match(/<v\s+([^>]+)>/);
    const joined = rows.join(' ').replace(/<v\s+[^>]+>/gi, '').replace(/<[^>]+>/g, '').trim();
    if (!joined) continue;

    const labelled = !voice ? joined.match(/^([^:]{1,40}):\s+(.+)$/) : null;
    const speaker = (voice && voice[1].trim()) || (labelled && labelled[1].trim()) || null;
    const body = (labelled ? labelled[2] : joined).trim();
    if (!body) continue;

    lines.push({ speaker, start: formatStamp(stamp?.[1]), text: body });
  }
  return lines.length ? lines : null;
}

function render(segments) {
  return segments
    .map((s) => {
      const stamp = s.start ? `[${s.start}] ` : '';
      const who = s.speaker ? `${s.speaker}: ` : '';
      return `${stamp}${who}${s.text}`;
    })
    .join('\n');
}

/**
 * @param {string} raw  pasted transcript content
 * @returns {{text: string, format: string, segments: number, speakers: string[]}}
 */
function normaliseTranscript(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { text: '', format: 'empty', segments: 0, speakers: [] };

  // 1. JSON of some shape.
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    let parsed = null;
    try { parsed = JSON.parse(trimmed); } catch { /* not valid JSON: fall through */ }

    if (parsed !== null) {
      let list = null;
      if (Array.isArray(parsed)) list = parsed;
      else if (typeof parsed === 'object') {
        const container = CONTAINER_KEYS.map((k) => parsed[k]).find((v) => Array.isArray(v));
        list = Array.isArray(container) ? container : null;
        // Single-segment object (one speaker, one blob of text).
        if (!list) {
          const only = pick(parsed, TEXT_KEYS);
          if (only) list = [parsed];
        }
      }

      if (list) {
        const segments = normaliseSegments(list);
        if (segments.length) {
          return {
            text: render(segments),
            format: 'json',
            segments: segments.length,
            speakers: [...new Set(segments.map((s) => s.speaker).filter(Boolean))],
          };
        }
      }
      // Parsed as JSON but nothing transcript-shaped inside -- keep the raw
      // text rather than throwing the content away.
      return { text: trimmed, format: 'json-unrecognised', segments: 0, speakers: [] };
    }
  }

  // 2. Captions.
  const captions = parseCaptions(trimmed);
  if (captions) {
    return {
      text: render(captions),
      format: /WEBVTT/i.test(trimmed) ? 'vtt' : 'srt',
      segments: captions.length,
      speakers: [...new Set(captions.map((s) => s.speaker).filter(Boolean))],
    };
  }

  // 3. Plain text -- already readable, store as-is.
  const speakers = [...trimmed.matchAll(/^\s*([A-Z][\w .'-]{1,40})\s*:\s+\S/gm)].map((m) => m[1].trim());
  return {
    text: trimmed,
    format: 'text',
    segments: trimmed.split(/\n+/).filter(Boolean).length,
    speakers: [...new Set(speakers)],
  };
}

module.exports = { normaliseTranscript, formatStamp };
