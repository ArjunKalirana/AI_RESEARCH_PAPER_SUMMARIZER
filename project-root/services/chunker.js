/**
 * Semantic chunker — splits text by natural paragraph boundaries (\n\n),
 * then merges small paragraphs together until they approach the target size.
 * This ensures sentences are NEVER cut in half, eliminating a key hallucination source.
 *
 * @param {string} text        - Full extracted PDF text
 * @param {number} targetWords - Soft max words per chunk (default: 500)
 * @param {number} overlapSentences - Number of sentences to overlap between chunks (default: 2)
 * @returns {Array<{chunkIndex, text}>}
 */
function chunkText(text, targetWords = 500, overlapSentences = 2) {
  if (!text || text.trim().length === 0) return [];

  // Step 1: Split by double newlines (paragraph boundaries)
  const rawParagraphs = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter((p) => p.length > 30); // drop noise/headers under 30 chars

  const chunks = [];
  let currentWords = [];
  let chunkIndex = 0;
  let overlapBuffer = []; // holds last N sentences for overlap

  for (const paragraph of rawParagraphs) {
    const paraWords = paragraph.split(" ");

    // If adding this paragraph would overflow, flush current chunk first
    if (currentWords.length + paraWords.length > targetWords && currentWords.length > 0) {
      const chunkText = currentWords.join(" ");
      chunks.push({ chunkIndex: chunkIndex++, text: chunkText });

      // ✅ Overlap: carry last `overlapSentences` sentences into next chunk
      // This preserves cross-boundary context so LLM doesn't lose thread
      overlapBuffer = getLastNSentences(chunkText, overlapSentences);
      currentWords = [...overlapBuffer.join(" ").split(" ").filter(Boolean)];
    }

    currentWords.push(...paraWords);
  }

  // Flush remaining words as final chunk
  if (currentWords.length > 0) {
    chunks.push({ chunkIndex: chunkIndex++, text: currentWords.join(" ") });
  }

  return chunks;
}

/**
 * Helper: extract the last N sentences from a block of text.
 * Used to create semantic overlap between consecutive chunks.
 */
function getLastNSentences(text, n) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  return sentences.slice(-n);
}

module.exports = { chunkText };