function extractSections(text) {
    const lower = text.toLowerCase();
  
    const sections = {};
    const markers = {
      abstract: "abstract",
      introduction: "introduction",
      methodology: "method",
      results: "result",
      conclusion: "conclusion",
    };
  
    const indexes = {};
  
    for (const key in markers) {
      const idx = lower.indexOf(markers[key]);
      if (idx !== -1) indexes[key] = idx;
    }
  
    const sorted = Object.entries(indexes).sort((a, b) => a[1] - b[1]);
  
    for (let i = 0; i < sorted.length; i++) {
      const [section, start] = sorted[i];
      const end = sorted[i + 1] ? sorted[i + 1][1] : text.length;
      sections[section] = text.slice(start, end).trim();
    }
  
    if (Object.keys(sections).length === 0) {
      sections.full_text = text;
    }
  
    return sections;
  }
  
  module.exports = { extractSections };
  