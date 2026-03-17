/**
 * Semantic chunker — splits text by natural paragraph boundaries (\n\n),
 * then merges small paragraphs together until they approach the target size.
 * If a single paragraph is too large, it splits it by sentences recursively.
 *
 * @param {string} text        - Full extracted PDF text
 * @param {number} targetWords - Soft max words per chunk (default: 500)
 * @param {number} overlapSentences - Number of sentences to overlap between chunks (default: 2)
 * @returns {Array<{chunkIndex, text}>}
 */
function chunkText(text, targetWords = 500, overlapSentences = 2) {
  if (!text || text.trim().length === 0) return [];

  // Step 1: Split by double newlines (paragraph boundaries)
  let rawParagraphs = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter((p) => p.length > 20);

  const chunks = [];
  let currentWords = [];
  let chunkIndex = 0;

  for (const paragraph of rawParagraphs) {
    const paraWords = paragraph.split(/\s+/);

    // If a single paragraph is larger than 1.5x target, split it by sentences
    if (paraWords.length > targetWords * 1.5) {
      const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
      for (const sentence of sentences) {
        const sentWords = sentence.split(/\s+/);
        if (currentWords.length + sentWords.length > targetWords && currentWords.length > 0) {
          flushChunk();
        }
        currentWords.push(...sentWords);
      }
      continue;
    }

    // Normal paragraph merging
    if (currentWords.length + paraWords.length > targetWords && currentWords.length > 0) {
      flushChunk();
    }
    currentWords.push(...paraWords);
  }

  // Flush remaining
  if (currentWords.length > 0) flushChunk();

  function flushChunk() {
    const chunkText = currentWords.join(" ").trim();
    if (chunkText.length > 0) {
      chunks.push({ chunkIndex: chunkIndex++, text: chunkText });
      
      // Overlap: Carry last N sentences
      const overlapBuffer = getLastNSentences(chunkText, overlapSentences);
      currentWords = overlapBuffer.join(" ").split(/\s+/).filter(Boolean);
    }
  }

  return chunks;
}

function getLastNSentences(text, n) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  return sentences.slice(-n);
}

module.exports = { chunkText };