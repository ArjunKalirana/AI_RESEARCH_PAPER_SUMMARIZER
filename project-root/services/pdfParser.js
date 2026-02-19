const fs = require("fs");

async function extractTextFromPDF(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath));

  // 🔑 ESM import – works with pdfjs-dist v4+ and Node 22
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;

  let fullText = "";

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // ✅ FIXED: Preserve line breaks based on Y-coordinates
    const pageText = extractTextWithLineBreaks(content.items);

    fullText += pageText + "\n";
  }

  return fullText;
}

/**
 * Extract text while preserving line breaks based on Y-coordinates
 * PDF text items have x/y coordinates - items on same Y are same line
 */
function extractTextWithLineBreaks(items) {
  if (items.length === 0) return "";

  // Group items by their Y-coordinate (vertical position)
  const lines = [];
  let currentLine = [];
  let currentY = items[0].transform[5]; // Y-coordinate
  const yThreshold = 2; // Tolerance for "same line" (pixels)

  items.forEach((item) => {
    const itemY = item.transform[5];
    const itemX = item.transform[4];

    // Check if this item is on a new line
    if (Math.abs(itemY - currentY) > yThreshold) {
      // Save current line and start new one
      if (currentLine.length > 0) {
        // Sort by X-coordinate (left to right)
        currentLine.sort((a, b) => a.x - b.x);
        const lineText = currentLine.map(i => i.str).join(" ");
        if (lineText.trim()) {
          lines.push(lineText.trim());
        }
      }
      currentLine = [];
      currentY = itemY;
    }

    currentLine.push({
      str: item.str,
      x: itemX,
      y: itemY
    });
  });

  // Don't forget the last line
  if (currentLine.length > 0) {
    currentLine.sort((a, b) => a.x - b.x);
    const lineText = currentLine.map(i => i.str).join(" ");
    if (lineText.trim()) {
      lines.push(lineText.trim());
    }
  }

  return lines.join("\n");
}

module.exports = { extractTextFromPDF };