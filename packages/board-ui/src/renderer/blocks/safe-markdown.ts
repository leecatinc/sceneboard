export type SafeMarkdownTokenV1 =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'unordered-item'; text: string }
  | { type: 'ordered-item'; text: string }
  | { type: 'code'; language: string | null; text: string }
  | { type: 'separator' };

export const tokenizeSafeMarkdownV1 = (markdown: string): SafeMarkdownTokenV1[] => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const tokens: SafeMarkdownTokenV1[] = [];
  let code: { language: string | null; lines: string[] } | null = null;
  for (const line of lines) {
    const fence = /^```([A-Za-z0-9_+.#-]{0,64})\s*$/.exec(line);
    if (fence !== null) {
      if (code === null) code = { language: fence[1] || null, lines: [] };
      else {
        tokens.push({ type: 'code', language: code.language, text: code.lines.join('\n') });
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.lines.push(line);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) tokens.push({ type: 'separator' });
    else {
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
      const quote = /^\s*>\s?(.*)$/.exec(line);
      if (heading !== null)
        tokens.push({
          type: 'heading',
          level: heading[1]?.length as 1 | 2 | 3,
          text: heading[2] ?? '',
        });
      else if (unordered !== null)
        tokens.push({ type: 'unordered-item', text: unordered[1] ?? '' });
      else if (ordered !== null) tokens.push({ type: 'ordered-item', text: ordered[1] ?? '' });
      else if (quote !== null) tokens.push({ type: 'quote', text: quote[1] ?? '' });
      else if (line.trim() !== '') tokens.push({ type: 'paragraph', text: line });
    }
  }
  if (code !== null)
    tokens.push({ type: 'code', language: code.language, text: code.lines.join('\n') });
  return tokens;
};
