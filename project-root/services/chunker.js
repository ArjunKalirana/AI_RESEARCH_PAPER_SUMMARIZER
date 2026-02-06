function chunkText(text, chunkSize = 700, overlap = 100) {
    const words = text.split(" ");
    const chunks = [];
  
    let start = 0;
    let index = 0;
  
    while (start < words.length) {
      const end = start + chunkSize;
      const chunkWords = words.slice(start, end);
  
      chunks.push({
        chunkIndex: index++,
        text: chunkWords.join(" "),
      });
  
      start = end - overlap;
    }
  
    return chunks;
  }
  
  module.exports = { chunkText };
  