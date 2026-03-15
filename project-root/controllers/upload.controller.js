const fs = require('fs');
const path = require('path');
const { extractTextFromPDF } = require('../services/pdfParser');
const { cleanText } = require('../services/textCleaner');
const { extractSections } = require('../services/sectionExtractor');
const { chunkText } = require('../services/chunker');
const { normalizePaperJSON, validatePaperJSON } = require('../services/paperNormalizer');
const { extractMetadata } = require('../services/metadataExtractor');
const { indexChunks } = require('../services/faissService');
const { runQuery } = require('../services/neo4j.service');
const { generateSummary, generateStructuredSummary } = require('../services/llmService');

const OUTPUT_DIR = path.join(__dirname, '../data/processed_papers');
const vectorMapPath = path.join(__dirname, '../data/vector_map.json');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function uploadPaper(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No PDF file uploaded.' });
    }

    const { filename, path: filePath, originalname } = req.file;
    console.log(`📄 Processing upload: ${filename}`);

    // 1️⃣ Extract and Clean Text
    const rawText = await extractTextFromPDF(filePath);
    if (!rawText || rawText.length < 500) {
      return res.status(400).json({ success: false, error: 'PDF contains too little text.' });
    }
    const cleanedText = cleanText(rawText);
    const metadata = extractMetadata(cleanedText, originalname);

    // 2️⃣ Extract Sections & Chunk Text
    const sections = extractSections(cleanedText);
    function assignSectionToChunk(chunkText, sections) {
      for (const [sectionName, sectionText] of Object.entries(sections)) {
        if (sectionText && chunkText && sectionText.includes(chunkText.slice(0, 50))) {
          return sectionName;
        }
      }
      return null;
    }

    const chunks = chunkText(cleanedText).map(chunk => ({
      chunkIndex: chunk.chunkIndex,
      chunkText: chunk.text,
      sectionName: assignSectionToChunk(chunk.text, sections)
    }));

    // 3️⃣ Basic Paper JSON
    const rawPaperJSON = {
      paperId: metadata.source.sourceName.toLowerCase() + '_' + filename.replace('.pdf', ''),
      title: metadata.title,
      year: metadata.year,
      source: metadata.source,
      authors: metadata.authors,
      sections,
      chunks,
      fullTextLength: cleanedText.length
    };

    const normalizedPaper = normalizePaperJSON(rawPaperJSON);
    validatePaperJSON(normalizedPaper);
    const { paperId, title, year, source, authors } = normalizedPaper;

    // 4️⃣ Embed all chunks (FAISS - Isolated per paper)
    console.log(`Embedding all ${chunks.length} chunks for ${paperId}...`);
    await indexChunks(chunks, paperId);

    // 5️⃣ Build Knowledge Graph (Neo4j)
    console.log(`📘 Ingesting into Neo4j: ${paperId}`);
    await runQuery(
      `MERGE (p:ResearchPaper {paperId: $paperId}) SET p.title = $title, p.year = $year`,
      { paperId, title, year }
    );
    if (source) {
      await runQuery(`MERGE (s:Source {sourceName: $name}) SET s.sourceURL = $url`, { name: source.sourceName, url: source.sourceURL });
      await runQuery(`MATCH (p:ResearchPaper {paperId: $paperId}) MATCH (s:Source {sourceName: $name}) MERGE (p)-[:SOURCED_FROM]->(s)`, { paperId, name: source.sourceName });
    }
    for (const author of authors) {
      await runQuery(`MERGE (a:Author {authorName: $name}) SET a.affiliation = $affiliation`, { name: author.authorName, affiliation: author.affiliation });
      await runQuery(`MATCH (p:ResearchPaper {paperId: $paperId}) MATCH (a:Author {authorName: $name}) MERGE (p)-[:WRITTEN_BY]->(a)`, { paperId, name: author.authorName });
    }
    for (const [sectionName, sectionText] of Object.entries(sections)) {
      await runQuery(`MERGE (s:Section {sectionName: $name}) SET s.sectionText = $text`, { name: sectionName, text: sectionText });
      await runQuery(`MATCH (p:ResearchPaper {paperId: $paperId}) MATCH (s:Section {sectionName: $name}) MERGE (p)-[:HAS_SECTION]->(s)`, { paperId, name: sectionName });
    }
    for (const chunk of chunks) {
      await runQuery(`MERGE (c:Chunk {paperId: $paperId, chunkIndex: $index}) SET c.chunkText = $text`, { paperId, index: chunk.chunkIndex, text: chunk.chunkText });
      await runQuery(`MATCH (p:ResearchPaper {paperId: $paperId}) MATCH (c:Chunk {paperId: $paperId, chunkIndex: $index}) MERGE (p)-[:HAS_CHUNK]->(c)`, { paperId, index: chunk.chunkIndex });
      if (chunk.sectionName) {
        await runQuery(`MATCH (c:Chunk {paperId: $paperId, chunkIndex: $index}) MATCH (s:Section {sectionName: $section}) MERGE (c)-[:REPRESENTS_PART_OF]->(s)`, { paperId, index: chunk.chunkIndex, section: chunk.sectionName });
      }
    }

    // 6️⃣ Generate Initial Summary
    console.log(`🧠 Generating Initial Summary for ${paperId}...`);
    const abstractChunk = chunks.find(c => c.sectionName === 'abstract') || chunks[0];
    const conclusionChunk = chunks.find(c => c.sectionName === 'conclusion') || chunks[chunks.length - 1];
    
    // De-duplicate if they happen to be the same chunk
    const selectedChunks = abstractChunk === conclusionChunk ? [abstractChunk] : [abstractChunk, conclusionChunk];
    
    const summaryContext = selectedChunks.map((c, i) => ({
        title, year, section: c.sectionName || "Intro/Outro", chunkText: c.chunkText
    }));
    
    const summaryPreview = await generateStructuredSummary(summaryContext);
    
    // Add summary to the final JSON
    normalizedPaper.summaryPreview = summaryPreview;
    
    // 7️⃣ Save Processed JSON
    const outPath = path.join(OUTPUT_DIR, `${paperId}.json`);
    fs.writeFileSync(outPath, JSON.stringify(normalizedPaper, null, 2));
    console.log(`✅ Request Complete: ${paperId}`);

    res.json({
      success: true,
      paperId,
      title,
      summaryPreview
    });

  } catch (error) {
    console.error('❌ Upload Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

module.exports = {
  uploadPaper
};
