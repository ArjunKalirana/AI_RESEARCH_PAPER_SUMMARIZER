// services/paperNormalizer.js

function normalizePaperJSON(paper) {
    return {
      paperId: paper.paperId || paper.paperName,
      title: paper.title || "Unknown Title",
      year: paper.year || null,
  
      source: paper.source || {
        sourceName: "manual",
        sourceURL: null
      },
  
      authors: paper.authors || [],
  
      sections: paper.sections || {},
  
      chunks: paper.chunks || [],
  
      fullTextLength: paper.textLength || 0
    };
  }
  
  function validatePaperJSON(paper) {
    if (!paper.paperId) {
      throw new Error("paperId is missing");
    }
  
    if (!Array.isArray(paper.chunks)) {
      throw new Error("chunks must be an array");
    }
  
    if (typeof paper.fullTextLength !== "number") {
      throw new Error("fullTextLength must be a number");
    }
  
    return true;
  }
  
  module.exports = {
    normalizePaperJSON,
    validatePaperJSON
  };
  