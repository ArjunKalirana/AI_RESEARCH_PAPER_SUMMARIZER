function cleanText(text) {
  return text
    // Remove excessive blank lines (3+ newlines → 2 newlines)
    .replace(/\n{3,}/g, "\n\n")
    
    // Remove excessive spaces (but keep single spaces)
    .replace(/[ \t]{2,}/g, " ")
    
    // Remove page numbers (common patterns)
    .replace(/Page\s+\d+/gi, "")
    .replace(/^\d+\s*$/gm, "") // Remove lines with only numbers
    
    // Remove form feed characters
    .replace(/\f/g, "")
    
    // Remove common PDF artifacts
    .replace(/\u0000/g, "") // Null characters
    .replace(/\ufffd/g, "") // Replacement character (�)
    
    // Clean up spaces around newlines
    .replace(/ +\n/g, "\n")
    .replace(/\n +/g, "\n")
    
    // Final trim
    .trim();
}

module.exports = { cleanText };