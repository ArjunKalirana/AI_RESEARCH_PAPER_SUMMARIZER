const fs = require("fs");
const path = require("path");

const { extractTextFromPDF } = require("../services/pdfParser");
const { cleanText } = require("../services/textCleaner");
const { extractSections } = require("../services/sectionExtractor");
const { chunkText } = require("../services/chunker");
const {
  normalizePaperJSON,
  validatePaperJSON
} = require("../services/paperNormalizer");
const { extractMetadata } = require("../services/metadataExtractor");

const RAW_DIR = path.join(__dirname, "../data/raw_papers");
const OUTPUT_DIR = path.join(__dirname, "../data/processed_papers");

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function ingest() {
  const files = fs.readdirSync(RAW_DIR).filter(f => f.endsWith(".pdf"));

  for (const file of files) {
    try {
      console.log(`📄 Processing: ${file}`);

      const filePath = path.join(RAW_DIR, file);
      const rawText = await extractTextFromPDF(filePath);

      if (!rawText || rawText.length < 500) {
        console.warn(`⚠️ Skipping ${file} (too little text)`);
        continue;
      }

      /* -----------------------------
         1️⃣ CLEAN TEXT
      ------------------------------*/
      const cleanedText = cleanText(rawText);
      const metadata = extractMetadata(cleanedText, file);


      /* -----------------------------
         2️⃣ EXTRACT SECTIONS
      ------------------------------*/
      const sections = extractSections(cleanedText);
      function assignSectionToChunk(chunkText, sections) {
        for (const [sectionName, sectionText] of Object.entries(sections)) {
          if (
            sectionText &&
            chunkText &&
            sectionText.includes(chunkText.slice(0, 50))
          ) {
            return sectionName;
          }
        }
        return null;
      }
      
      /* -----------------------------
         3️⃣ CHUNK TEXT
      ------------------------------*/
      const chunks = chunkText(cleanedText).map(chunk => ({
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.text,
        sectionName: assignSectionToChunk(chunk.text, sections)
      }));

      /* -----------------------------
         4️⃣ RAW PAPER JSON
      ------------------------------*/
      const rawPaperJSON = {
        paperId:metadata.source.sourceName.toLowerCase()
        + "_" + file.replace(".pdf", ""),
        title: metadata.title,
        year: metadata.year,
        source: metadata.source,
        authors: metadata.authors,         
        sections,
        chunks,
        fullTextLength: cleanedText.length
      };

      /* -----------------------------
         5️⃣ NORMALIZE + VALIDATE
      ------------------------------*/
      const normalizedPaper = normalizePaperJSON(rawPaperJSON);
      validatePaperJSON(normalizedPaper);

      /* -----------------------------
         6️⃣ WRITE FINAL JSON
      ------------------------------*/
      const outPath = path.join(
        OUTPUT_DIR,
        `${normalizedPaper.paperId}.json`
      );

      fs.writeFileSync(outPath, JSON.stringify(normalizedPaper, null, 2));

      console.log(`✅ Saved: ${outPath}`);
    } catch (err) {
      console.error(`❌ Failed processing ${file}:`, err.message);
    }
  }

  console.log("🎉 Ingestion completed successfully!");
}

ingest();
