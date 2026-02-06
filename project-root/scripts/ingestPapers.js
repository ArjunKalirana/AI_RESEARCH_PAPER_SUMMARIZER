const fs = require("fs");
const path = require("path");

const { extractTextFromPDF } = require("../services/pdfParser");
const { cleanText } = require("../services/textCleaner");
const { extractSections } = require("../services/sectionExtractor");
const { chunkText } = require("../services/chunker");

const RAW_DIR = path.join(__dirname, "../data/raw_papers");
const OUTPUT_DIR = path.join(__dirname, "../data/processed_papers");

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function ingest() {
  const files = fs.readdirSync(RAW_DIR).filter(f => f.endsWith(".pdf"));

  for (const file of files) {
    console.log(`📄 Processing: ${file}`);

    const filePath = path.join(RAW_DIR, file);
    const rawText = await extractTextFromPDF(filePath);

    if (rawText.length < 500) {
      console.warn(`⚠️ Skipping ${file} (too little text)`);
      continue;
    }

    const cleanedText = cleanText(rawText);
    const sections = extractSections(cleanedText);
    const chunks = chunkText(cleanedText);

    const output = {
      paperName: file,
      textLength: cleanedText.length,
      sections,
      chunks,
      createdAt: new Date().toISOString(),
    };

    const outPath = path.join(
      OUTPUT_DIR,
      file.replace(".pdf", ".json")
    );

    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

    console.log(`✅ Saved: ${outPath}`);
  }

  console.log("🎉 Ingestion completed!");
}

ingest();
