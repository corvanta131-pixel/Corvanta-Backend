function chunkText(text, options = {}) {
  const size = Math.max(64, Number(options.size) || 1200);
  const overlap = Math.max(0, Math.min(Number(options.overlap) || 0, Math.floor(size / 2)));
  const max = Math.max(size, Number(options.max) || 4000);
  const cleaned = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  const paragraphs = cleaned.split(/\n{2,}/);
  const chunks = [];
  let buffer = "";
  let bufferStart = 0;
  let cursor = 0;

  function pushBuffer() {
    if (!buffer) return;
    const content = buffer.trim();
    if (content.length > max) {
      chunks.push(...hardSplit(content, max, overlap));
    } else if (content) {
      chunks.push({ content, start: bufferStart, end: bufferStart + content.length });
    }
    buffer = "";
  }

  for (const paragraph of paragraphs) {
    const piece = paragraph.trim();
    if (!piece) {
      cursor += paragraph.length + 2;
      continue;
    }
    if (piece.length >= size) {
      pushBuffer();
      const base = cursor;
      chunks.push(...hardSplit(piece, size, overlap).map((chunk) => ({
        content: chunk.content,
        start: base + chunk.start,
        end: base + chunk.end,
      })));
      cursor += piece.length + 2;
      bufferStart = cursor;
      continue;
    }
    const next = buffer ? `${buffer}\n\n${piece}` : piece;
    if (next.length > size && buffer) {
      pushBuffer();
      buffer = piece;
      bufferStart = cursor;
    } else {
      buffer = next;
    }
    cursor += piece.length + 2;
  }
  pushBuffer();

  return chunks
    .filter((chunk) => chunk.content && chunk.content.length > 0)
    .map((chunk, index) => ({
      content: chunk.content,
      start: chunk.start,
      end: chunk.end,
      index,
    }));
}

function hardSplit(text, size, overlap) {
  const chunks = [];
  const step = Math.max(1, size - overlap);
  for (let i = 0; i < text.length; i += step) {
    const slice = text.slice(i, i + size);
    if (!slice) break;
    chunks.push({ content: slice, start: i, end: i + slice.length });
  }
  return chunks;
}

module.exports = { chunkText };
