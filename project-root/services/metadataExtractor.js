const { extractAuthors } = require("./authorExtractor");

function extractMetadata(cleanedText, fileName) {
  const lines = cleanedText
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const title = extractTitleFromFirstPage(lines, cleanedText);
  const authors = extractAuthors(lines, title, cleanedText);
  const year = extractYear(cleanedText);
  const source = extractSource(cleanedText, fileName);

  return {
    title,
    authors,
    year,
    source
  };
}

/* =============================
   TITLE EXTRACTION - HANDLES MERGED LINES
============================= */

function extractTitleFromFirstPage(lines, fullText) {
  // Strategy 1: Extract from the very first line (common for merged PDFs)
  const titleFromFirstLine = extractTitleFromMergedLine(lines[0]);
  if (titleFromFirstLine) return titleFromFirstLine;

  // Strategy 2: Look for arXiv pattern
  const titleFromArxiv = extractTitleArxivPattern(lines);
  if (titleFromArxiv) return titleFromArxiv;

  // Strategy 3: Find before "Abstract"
  const titleFromAbstract = extractTitleBeforeAbstract(lines);
  if (titleFromAbstract) return titleFromAbstract;

  // Strategy 4: Smart pattern matching in text
  const titleFromPattern = extractTitleFromPattern(fullText);
  if (titleFromPattern) return titleFromPattern;

  // Strategy 5: Heuristic on cleaned lines
  const titleFromHeuristics = extractTitleHeuristic(lines);
  if (titleFromHeuristics) return titleFromHeuristics;

  return "Unknown Title";
}

/**
 * Extract title from merged first line (most common issue)
 * Pattern: "Title Author1 Author2 ..."
 */
function extractTitleFromMergedLine(firstLine) {
  if (!firstLine || firstLine.length < 10) return null;

  // Common patterns in merged first lines:
  // "Language Models are Few-Shot Learners Tom B. Brown ∗ Benjamin Mann ∗"
  
  // Strategy 1: Split at author indicators (∗, †, numbers with commas)
  const authorIndicators = /[∗†‡§¶]|\d\s*,\s*\d/;
  const match = firstLine.match(new RegExp(`^(.+?)\\s+[A-Z][a-z]+\\s+[A-Z]\\.?\\s+[A-Z][a-z]+\\s*${authorIndicators.source}`));
  
  if (match) {
    const candidate = match[1].trim();
    if (candidate.length >= 10 && candidate.length <= 200) {
      return normalizeTitle(candidate);
    }
  }

  // Strategy 2: Look for title ending before a name pattern
  // Matches: "Title Here John Smith" or "Title Here J. Smith"
  const beforeName = firstLine.match(/^(.+?)\s+[A-Z][a-z]+\s+[A-Z]\.?\s+[A-Z][a-z]+/);
  if (beforeName) {
    const candidate = beforeName[1].trim();
    if (candidate.length >= 15 && candidate.length <= 200 && candidate.split(/\s+/).length >= 3) {
      return normalizeTitle(candidate);
    }
  }

  // Strategy 3: Look for title ending before multiple capital words
  // Matches patterns like: "Title Here AUTHOR1 AUTHOR2"
  const beforeCaps = firstLine.match(/^(.+?)\s+([A-Z]{2,}\s+){2,}/);
  if (beforeCaps) {
    const candidate = beforeCaps[1].trim();
    if (candidate.length >= 15 && candidate.length <= 200) {
      return normalizeTitle(candidate);
    }
  }

  // Strategy 4: For very long first lines, extract first 3-15 words as potential title
  if (firstLine.length > 100) {
    const words = firstLine.split(/\s+/);
    
    // Try different word counts
    for (let wordCount = 15; wordCount >= 4; wordCount--) {
      const candidate = words.slice(0, wordCount).join(" ");
      
      // Check if this looks like a title (not starting with Figure, Table, etc.)
      if (!candidate.match(/^(Figure|Table|Contents|Abstract|Introduction|\d+)/i) &&
          candidate.length >= 20 && 
          candidate.length <= 150) {
        
        // Additional validation: should end on a meaningful word, not "the", "a", "an"
        const lastWord = words[wordCount - 1]?.toLowerCase();
        if (!["the", "a", "an", "of", "in", "on", "at", "to"].includes(lastWord)) {
          return normalizeTitle(candidate);
        }
      }
    }
  }

  return null;
}

/**
 * Extract title using pattern matching in full text
 */
function extractTitleFromPattern(fullText) {
  // Look for arXiv pattern followed by title
  const arxivPattern = /(?:arXiv:\d{4}\.\d{4,5}|arXiv preprint)\s*(?:v\d+)?\s*\n\s*(.+?)(?:\n|$)/i;
  const match = fullText.match(arxivPattern);
  
  if (match && match[1]) {
    const candidate = match[1].trim();
    if (candidate.length >= 10 && candidate.length <= 200) {
      return normalizeTitle(candidate);
    }
  }

  return null;
}

/**
 * Extract from arXiv papers
 */
function extractTitleArxivPattern(lines) {
  const arxivIndex = lines.findIndex(l => 
    l.toLowerCase().includes("arxiv") || 
    /\d{4}\.\d{4,5}/.test(l)
  );

  if (arxivIndex === -1) return null;

  // Check the arXiv line itself for merged title
  if (arxivIndex === 0) {
    const titleFromMerged = extractTitleFromMergedLine(lines[0]);
    if (titleFromMerged) return titleFromMerged;
  }

  const abstractIndex = lines.findIndex(l => 
    l.toLowerCase() === "abstract" || 
    l.toLowerCase().startsWith("abstract")
  );

  if (abstractIndex === -1 || abstractIndex <= arxivIndex) return null;

  const searchEnd = Math.min(arxivIndex + 10, abstractIndex);
  
  for (let i = arxivIndex + 1; i < searchEnd; i++) {
    const line = lines[i];
    if (isValidTitleCandidate(line)) {
      return normalizeTitle(line);
    }
  }

  return null;
}

/**
 * Extract title before Abstract section
 */
function extractTitleBeforeAbstract(lines) {
  const abstractIndex = lines.findIndex(l => 
    l.toLowerCase() === "abstract" || 
    l.toLowerCase().startsWith("abstract ")
  );

  if (abstractIndex === -1) return null;

  const scanLimit = Math.min(30, abstractIndex);
  
  const candidates = lines.slice(0, scanLimit)
    .filter(l => isValidTitleCandidate(l))
    .map((candidate, idx) => ({
      text: candidate,
      score: scoreTitleCandidate(candidate, lines.indexOf(candidate), lines)
    }));

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  return normalizeTitle(candidates[0].text);
}

/**
 * Heuristic-based extraction
 */
function extractTitleHeuristic(lines) {
  const candidates = lines.slice(0, 40)
    .filter(l => isValidTitleCandidate(l))
    .map((candidate, idx) => ({
      text: candidate,
      score: scoreTitleCandidate(candidate, idx, lines)
    }));

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  return normalizeTitle(candidates[0].text);
}

/**
 * Validate title candidates
 */
function isValidTitleCandidate(line) {
  const lower = line.toLowerCase();

  // Reject patterns
  const rejectPatterns = [
    /^arxiv/i,
    /^preprint/i,
    /^proceedings/i,
    /^copyright/i,
    /^vol\.|^volume/i,
    /^pp\.|^pages/i,
    /^doi:/i,
    /^isbn/i,
    /^issn/i,
    /^published/i,
    /^accepted/i,
    /^received/i,
    /^revised/i,
    /^contents/i,
    /^[ivx]+\./i,
    /^(january|february|march|april|may|june|july|august|september|october|november|december)/i,
    /^figure\s+\d/i,
    /^table\s+\d/i,
    /^section\s+\d/i,
    /^appendix/i
  ];

  if (rejectPatterns.some(pattern => pattern.test(line))) {
    return false;
  }

  // Reject if just a year
  if (/^\d{4}$/.test(line.trim())) return false;

  // Reject emails and URLs
  if (line.includes("@") || line.includes("http")) return false;

  // Reject common headers (exact match)
  const commonHeaders = ["abstract", "introduction", "keywords", "references", "acknowledgments"];
  if (commonHeaders.includes(lower.trim())) return false;

  // Length check: 10-500 chars (increased max for merged lines)
  if (line.length < 10 || line.length > 500) return false;

  // Must contain letters
  if (!/[a-zA-Z]/.test(line)) return false;

  // Must have at least 2 words
  const words = line.split(/\s+/).filter(w => w.length > 0);
  if (words.length < 2) return false;

  return true;
}

/**
 * Score candidates
 */
function scoreTitleCandidate(line, lineIndex, allLines) {
  let score = 0;

  const len = line.length;
  const wordCount = line.split(/\s+/).length;

  // Length scoring (adjusted for merged lines)
  if (len >= 20 && len <= 100) {
    score += 40;
  } else if (len >= 15 && len <= 150) {
    score += 25;
  } else if (len >= 10 && len <= 200) {
    score += 10;
  }

  // Word count
  if (wordCount >= 4 && wordCount <= 12) {
    score += 30;
  } else if (wordCount >= 3 && wordCount <= 20) {
    score += 15;
  }

  // Position bonus
  if (lineIndex === 0) {
    score += 50;  // First line is often the title
  } else if (lineIndex >= 1 && lineIndex <= 3) {
    score += 30;
  } else if (lineIndex >= 4 && lineIndex <= 10) {
    score += 15;
  }

  // Case diversity
  const hasUpperAndLower = /[a-z]/.test(line) && /[A-Z]/.test(line);
  if (hasUpperAndLower) {
    score += 15;
  }

  // Colon (common in academic titles)
  if (line.includes(":")) {
    score += 10;
  }

  // Technical/academic terms
  const academicTerms = [
    /\b(analysis|study|approach|method|system|model|framework|algorithm|survey|review)\b/i,
    /\b(learning|neural|network|deep|machine|data|training)\b/i,
    /\b(using|based|via|through|toward|towards)\b/i,
    /\b(efficient|novel|improved|enhanced|robust)\b/i
  ];
  if (academicTerms.some(pattern => pattern.test(line))) {
    score += 15;
  }

  // Penalize excessive numbers
  const numberCount = (line.match(/\d/g) || []).length;
  if (numberCount > len * 0.15) {
    score -= 20;
  }

  // Penalize author indicators
  if (line.includes("∗") || line.includes("†") || line.includes("‡")) {
    score -= 30;
  }

  // Penalize if contains common author patterns
  if (/[A-Z]\.\s*[A-Z]\./.test(line)) {
    score -= 15;
  }

  // Penalize if too many capital words in a row (likely author names)
  const capsSequence = line.match(/\b[A-Z][a-z]+\s+[A-Z]\.\s+[A-Z][a-z]+/);
  if (capsSequence) {
    score -= 20;
  }

  return score;
}

/**
 * Normalize title
 */
function normalizeTitle(title) {
  let normalized = title.trim();

  // Remove trailing punctuation
  normalized = normalized.replace(/^[.\-–—:;,]+|[.\-–—:;,]+$/g, "");

  // Remove author indicators
  normalized = normalized.replace(/[∗†‡§¶]/g, "");

  // If ALL CAPS, convert to Title Case
  if (normalized === normalized.toUpperCase() && normalized.length > 5) {
    normalized = toTitleCase(normalized);
  }

  // Clean up spacing
  normalized = normalized.replace(/\s+/g, " ");

  // Limit length
  if (normalized.length > 200) {
    normalized = normalized.substring(0, 197) + "...";
  }

  return normalized;
}

function toTitleCase(str) {
  const smallWords = ["a", "an", "the", "and", "but", "or", "for", "nor", "on", "at", "to", "from", "by", "of", "in"];
  
  return str.toLowerCase()
    .split(/\s+/)
    .map((word, idx) => {
      if (idx === 0 || !smallWords.includes(word.toLowerCase())) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      }
      return word.toLowerCase();
    })
    .join(" ");
}

/* =============================
   YEAR
============================= */

function extractYear(text) {
  const matches = text.match(/\b(19\d{2}|20[0-2]\d|2030)\b/g);
  
  if (!matches) return null;

  const years = matches.map(y => parseInt(y))
    .filter(y => y >= 1950 && y <= 2030);
  
  if (years.length === 0) return null;

  // Return most common year
  const yearCounts = {};
  years.forEach(y => {
    yearCounts[y] = (yearCounts[y] || 0) + 1;
  });

  const sortedYears = Object.entries(yearCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([year]) => parseInt(year));

  return sortedYears[0];
}

/* =============================
   SOURCE
============================= */

function extractSource(text, fileName) {
  const lower = text.toLowerCase();

  if (lower.includes("arxiv") || fileName.match(/\d{4}\.\d{4,5}/)) {
    const idMatch = text.match(/(\d{4}\.\d{4,5})(v\d+)?/);
    return {
      sourceName: "arXiv",
      sourceURL: idMatch ? `https://arxiv.org/abs/${idMatch[0]}` : null
    };
  }

  if (lower.includes("ieee")) {
    return { sourceName: "IEEE", sourceURL: null };
  }

  if (lower.includes("acm")) {
    return { sourceName: "ACM", sourceURL: null };
  }

  return { sourceName: "manual", sourceURL: null };
}

module.exports = { extractMetadata };