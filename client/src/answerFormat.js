/** Parse the small, safe Markdown subset used for assistant chat responses. */
export function parseAnswerBlocks(content) {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;

  const headingAt = (line) => line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  const unorderedAt = (line) => line.match(/^\s*[-*+]\s+(.+)$/);
  const orderedAt = (line) => line.match(/^\s*\d+[.)]\s+(.+)$/);
  const startsBlock = (line) => Boolean(
    headingAt(line) || unorderedAt(line) || orderedAt(line) || /^\s*```/.test(line)
  );

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      index += 1;
      continue;
    }

    if (/^\s*```/.test(line)) {
      index += 1;
      const code = [];
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }

    const heading = headingAt(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    const firstUnordered = unorderedAt(line);
    const firstOrdered = orderedAt(line);
    if (firstUnordered || firstOrdered) {
      const ordered = Boolean(firstOrdered);
      const items = [];
      while (index < lines.length) {
        const match = ordered ? orderedAt(lines[index]) : unorderedAt(lines[index]);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push({ type: ordered ? 'ordered-list' : 'unordered-list', items });
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}
