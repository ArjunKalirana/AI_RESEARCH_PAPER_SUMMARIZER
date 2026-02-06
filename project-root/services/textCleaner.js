function cleanText(text) {
    return text
      .replace(/\n{2,}/g, "\n")
      .replace(/\s{2,}/g, " ")
      .replace(/Page\s\d+/gi, "")
      .replace(/\f/g, "")
      .trim();
  }
  
  module.exports = { cleanText };
  