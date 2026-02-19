/**
 * Extract authors - handles multiple formats and edge cases
 */
function extractAuthors(lines, title, fullText) {
  const authors = [];

  // Find where to start looking for authors
  let titleIndex = -1;
  if (title) {
    // Try exact match first
    titleIndex = lines.findIndex(l => l === title);
    
    // If not found, try partial match (for multi-line titles)
    if (titleIndex === -1) {
      titleIndex = lines.findIndex(l => l.includes(title.substring(0, 30)));
    }
  }

  // Skip multi-line titles
  let startIndex = titleIndex >= 0 ? titleIndex + 1 : 0;
  
  // Skip additional title lines (like "Early experiments with GPT-4")
  while (startIndex < lines.length && 
         lines[startIndex].length > 10 && 
         !looksLikeAuthorLine(lines[startIndex]) &&
         !isSingleAuthorName(lines[startIndex]) &&
         !isContentSection(lines[startIndex])) {
    // Check if it's a subtitle (not all caps, reasonable length, no name pattern)
    if (!/^[A-Z\s:]+$/.test(lines[startIndex]) && 
        !/\b[A-Z][a-z]+\s+[A-Z][a-z]+/.test(lines[startIndex])) {
      startIndex++;
    } else {
      break;
    }
  }

  // Strategy 1: Multi-line format (one author per line)
  extractAuthorsMultiLine(lines, startIndex, authors);
  
  if (authors.length > 0) {
    return authors;
  }

  // Strategy 2: Single-line format (comma/and separated)
  extractAuthorsSingleLine(lines, startIndex, authors);

  if (authors.length > 0) {
    return authors;
  }

  // Strategy 3: Space-separated format
  extractAuthorsSpaceSeparated(lines, startIndex, authors);

  return authors.slice(0, 30);
}

/**
 * Extract authors in multi-line format
 */
function extractAuthorsMultiLine(lines, startIndex, authors) {
  let consecutiveNameCount = 0;
  let lastWasName = false;

  for (let i = startIndex; i < Math.min(startIndex + 50, lines.length); i++) {
    const line = lines[i].trim();

    // Stop at content sections
    if (isContentSection(line)) {
      break;
    }

    // Skip symbol-only lines, commas, backticks
    if (!line || /^[∗†‡§¶,`\s]+$/.test(line)) {
      continue;
    }

    // Clean leading punctuation (like ", Christian Knabenhans")
    const cleanedLine = line.replace(/^[,\s]+/, '');

    // Stop at affiliations (but only if we already have some authors)
    if (isAffiliation(cleanedLine)) {
      if (authors.length >= 2) {
        break;
      }
      continue;
    }

    // Check if this is a single author name
    if (isSingleAuthorName(cleanedLine)) {
      const name = cleanAuthorName(cleanedLine);
      if (name && !authors.some(a => a.authorName === name)) {
        authors.push({
          authorName: name,
          affiliation: null
        });
        consecutiveNameCount++;
        lastWasName = true;
      }
    } 
    // Check if line has multiple space-separated names
    else if (hasMultipleNames(cleanedLine)) {
      extractNamesFromSpaceSeparatedLine(cleanedLine, authors);
      lastWasName = true;
    }
    // Check if line has comma-separated names
    else if (hasCommaSeparatedNames(cleanedLine)) {
      extractAuthorsFromLine(cleanedLine, authors);
      lastWasName = true;
    }
    else {
      // Not a name line
      if (authors.length >= 3 && lastWasName) {
        // We have a good set of authors, stop here
        break;
      }
      lastWasName = false;
    }
  }
}

/**
 * Check if line has multiple space-separated names (no commas)
 */
function hasMultipleNames(line) {
  // Pattern: "FirstName LastName FirstName LastName" (2+ names)
  const namePattern = /\b[A-Z][a-z]+\s+(?:[A-Z]\.?\s+)?[A-Z][a-z]+/g;
  const matches = line.match(namePattern);
  return matches && matches.length >= 2;
}

/**
 * Extract multiple names from a space-separated line
 */
function extractNamesFromSpaceSeparatedLine(line, authors) {
  // This handles lines like:
  // "Prafulla Dhariwal Arvind Neelakantan Pranav Shyam Girish Sastry"
  
  const words = line.split(/\s+/);
  let i = 0;
  
  while (i < words.length) {
    // Try to match: FirstName MiddleInitial. LastName
    if (i + 2 < words.length && 
        /^[A-Z][a-z]+$/.test(words[i]) &&
        /^[A-Z]\.$/.test(words[i + 1]) &&
        /^[A-Z][a-z]+$/.test(words[i + 2])) {
      const name = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      if (isValidAuthorName(name) && !authors.some(a => a.authorName === name)) {
        authors.push({ authorName: name, affiliation: null });
      }
      i += 3;
    }
    // Try to match: FirstName LastName
    else if (i + 1 < words.length &&
             /^[A-Z][a-z]+$/.test(words[i]) &&
             /^[A-Z][a-z]+(-[A-Z][a-z]+)?$/.test(words[i + 1])) {
      const name = `${words[i]} ${words[i + 1]}`;
      if (isValidAuthorName(name) && !authors.some(a => a.authorName === name)) {
        authors.push({ authorName: name, affiliation: null });
      }
      i += 2;
    }
    else {
      i++;
    }
  }
}

/**
 * Check if line has comma-separated names
 */
function hasCommaSeparatedNames(line) {
  return line.includes(',') && 
         !line.includes('@') && 
         /[A-Z][a-z]+/.test(line);
}

/**
 * Extract authors in single-line format
 */
function extractAuthorsSingleLine(lines, startIndex, authors) {
  for (let i = startIndex; i < Math.min(startIndex + 20, lines.length); i++) {
    const line = lines[i];

    if (isContentSection(line)) {
      break;
    }

    if (looksLikeAuthorLine(line)) {
      extractAuthorsFromLine(line, authors);
      if (authors.length > 0) {
        break;
      }
    }
  }
}

/**
 * Extract space-separated authors
 */
function extractAuthorsSpaceSeparated(lines, startIndex, authors) {
  for (let i = startIndex; i < Math.min(startIndex + 10, lines.length); i++) {
    const line = lines[i];

    if (isContentSection(line) || isAffiliation(line)) {
      break;
    }

    if (hasMultipleNames(line)) {
      extractNamesFromSpaceSeparatedLine(line, authors);
      if (authors.length >= 2) {
        break;
      }
    }
  }
}

/**
 * Check if a cleaned line is a single author name
 */
function isSingleAuthorName(name) {
  if (!name || name.length < 3 || name.length > 50) return false;
  
  // Must not be all caps (likely section header)
  if (name === name.toUpperCase() && name.length > 5) return false;
  
  const words = name.split(/\s+/).filter(w => w.length > 0);
  
  // Should be 2-4 words for a single name
  if (words.length < 2 || words.length > 4) return false;

  // All words should start with capital or be initials
  const allCaps = words.every(word => {
    if (word.length <= 2 && word.match(/^[A-Z]\.?$/)) return true;
    return /^[A-Z][a-z]+(-[A-Z][a-z]+)?$/.test(word);
  });

  if (!allCaps) return false;

  return isValidAuthorName(name);
}

/**
 * Check if line is an affiliation/organization
 */
function isAffiliation(line) {
  const lower = line.toLowerCase();
  
  const affiliationKeywords = [
    "university", "institute", "college", "school", "department",
    "laboratory", "lab ", " lab", "center", "centre", "research",
    "corporation", "company", "inc", "ltd", "llc",
    "email", "@", "http", "www",
    "equal contribution", "these authors",
    "china", "usa", "japan", "germany", "france", "uk"
  ];

  return affiliationKeywords.some(keyword => lower.includes(keyword));
}

/**
 * Check if line looks like author line (single-line format)
 */
function looksLikeAuthorLine(line) {
  if (line.length < 5 || line.length > 500) return false;

  const strongIndicators = [
    /[∗†‡§¶]/,
    /\b[A-Z][a-z]+\s+[A-Z]\.\s+[A-Z][a-z]+/,
    /\b[A-Z][a-z]+\s+[A-Z][a-z]+(?:\s*,\s*[A-Z][a-z]+\s+[A-Z][a-z]+){2,}/,
  ];

  if (strongIndicators.some(pattern => pattern.test(line))) {
    return true;
  }

  let indicatorCount = 0;
  if (line.includes(",") && !line.includes("@")) indicatorCount++;
  if (/\band\b/i.test(line)) indicatorCount++;
  
  const capWords = line.match(/\b[A-Z][a-z]+/g);
  if (capWords && capWords.length >= 4) indicatorCount++;

  return indicatorCount >= 2;
}

/**
 * Extract authors from a line (comma/and separated)
 */
function extractAuthorsFromLine(line, authors) {
  let cleanLine = line
    .replace(/[\*†‡§¶]/g, "")
    .replace(/\d+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const parts = splitAuthorLine(cleanLine);

  parts.forEach(part => {
    const name = cleanAuthorName(part);
    
    if (name && isValidAuthorName(name)) {
      if (!authors.some(a => a.authorName === name)) {
        authors.push({
          authorName: name,
          affiliation: null
        });
      }
    }
  });
}

/**
 * Split author line by separators
 */
function splitAuthorLine(line) {
  const parts = [];
  
  if (line.includes(",")) {
    const commaParts = line.split(/,\s*(?:and\s+)?/i);
    commaParts.forEach(part => {
      if (/\band\b/i.test(part)) {
        parts.push(...part.split(/\s+and\s+/i));
      } else {
        parts.push(part);
      }
    });
  } else if (/\band\b/i.test(line)) {
    parts.push(...line.split(/\s+and\s+/i));
  } else {
    parts.push(line);
  }

  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * Clean author name
 */
function cleanAuthorName(name) {
  let clean = name.trim();

  // Remove leading/trailing punctuation
  clean = clean.replace(/^[,.\-–—:;]+|[,.\-–—:;]+$/g, "");

  // Remove symbols
  clean = clean.replace(/[∗†‡§¶]/g, "");

  // Remove parenthetical info
  clean = clean.replace(/\([^)]*\)/g, "");

  // Remove numbers
  clean = clean.replace(/\d+/g, "");

  // Remove affiliation keywords
  clean = clean.replace(/,?\s*(University|Institute|College|Department|Lab|Center|School).*$/i, "");

  // Normalize spaces
  clean = clean.replace(/\s+/g, " ").trim();

  // Fix special characters
  clean = clean.replace(/´\s*/g, "'");  // Fix accent marks

  return clean;
}

/**
 * Validate author name
 */
function isValidAuthorName(name) {
  if (!name || name.length < 3) return false;
  if (!/[a-zA-Z]/.test(name)) return false;

  const words = name.split(/\s+/).filter(w => w.length > 0);

  // 2-5 words
  if (words.length < 2 || words.length > 5) return false;

  // Each word should be capitalized or initial
  const validWords = words.every(word => {
    if (word.length === 1 || (word.length === 2 && word.endsWith("."))) {
      return /^[A-Z]/.test(word);
    }
    // Allow hyphens and apostrophes in names
    return /^[A-Z][a-z]+(-[A-Z][a-z]+|'[A-Z]?[a-z]+)?$/.test(word);
  });

  if (!validWords) return false;

  // No invalid characters
  if (/[0-9@#$%^&*()+=[\]{}\\|<>?/]/.test(name)) return false;

  // Reject non-name words
  const nonNameWords = [
    "abstract", "introduction", "university", "institute", "department",
    "college", "school", "laboratory", "center", "email", "corresponding",
    "author", "authors", "et al", "equal contribution", "these authors",
    "table", "figure", "equation", "section", "chapter", "appendix",
    "january", "february", "march", "april", "may", "june", "july",
    "august", "september", "october", "november", "december",
    "preprint", "arxiv", "published", "accepted", "received", "revised",
    "research", "qualcomm", "openai", "microsoft", "google", "meta",
    "natural", "english", "chinese", "code", "mixed", "generation",
    "early", "experiments", "evaluating", "modal", "mathematical",
    "reasoning", "vision", "language", "models"
  ];

  const lowerName = name.toLowerCase();
  if (nonNameWords.some(word => lowerName === word || lowerName.includes(" " + word + " "))) {
    return false;
  }

  if (name.length > 50) return false;

  return true;
}

/**
 * Check if line is a content section
 */
function isContentSection(line) {
  const lower = line.toLowerCase().trim();
  
  const sections = [
    "abstract",
    "introduction", 
    "background",
    "related work",
    "methodology",
    "methods",
    "results",
    "discussion",
    "conclusion",
    "conclusions",
    "references",
    "acknowledgment",
    "acknowledgement",
    "appendix"
  ];

  return sections.some(section => {
    return lower === section || 
           lower.startsWith(section + " ") ||
           lower.startsWith(section + " —") ||
           lower.startsWith(section + "—");
  });
}

module.exports = {
  extractAuthors,
  isValidAuthorName,
  cleanAuthorName
};