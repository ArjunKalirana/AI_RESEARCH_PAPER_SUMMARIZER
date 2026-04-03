const fs = require('fs');
const path = require('path');
const { extractTextFromPDF } = require('../services/pdfParser');
const { cleanText } = require('../services/textCleaner');
const { extractSections } = require('../services/sectionExtractor');
const { chunkText } = require('../services/chunker');
const { normalizePaperJSON, validatePaperJSON } = require('../services/paperNormalizer');
const { extractMetadata } = require('../services/metadataExtractor');
const { indexChunks, warmUpIndex } = require('../services/faissService');
const { runQuery } = require('../services/neo4j.service');
const { generateSummary, generateStructuredSummary, summarizePaperSection, generatePaperTags } = require('../services/llmService');
const { updatePaperMeta } = require('../services/libraryMetaService');

const OUTPUT_DIR = path.join(__dirname, '../data/processed_papers');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function uploadPaper(req, res) {
  const isSSE = req.path.includes('stream');
  let clientGone = false;

  if (isSSE) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    
    // Initial comment to establish H2 stream immediately
    res.write(': established\n\n');
    res.flushHeaders();

    // Heartbeat every 15s to keep connection alive through proxies
    const heartbeat = setInterval(() => {
        if (!clientGone && !res.writableEnded) {
            res.write(': keep-alive\n\n');
        }
    }, 15000);

    req.on('close', () => {
      clientGone = true;
      clearInterval(heartbeat);
      console.log('[upload-stream] Client disconnected — aborting pipeline.');
      if (req.file && req.file.path) {
        fs.unlink(req.file.path, () => {});
      }
    });
  }

  const sendEvent = (payload) => {
    if (clientGone || res.writableEnded) return Promise.resolve(false);
    return new Promise((resolve) => {
      const line = `data: ${JSON.stringify(payload)}\n\n`;
      const ok = res.write(line);
      if (ok) resolve(true);
      else res.once('drain', () => resolve(true));
    });
  };

  const shouldAbort = () => clientGone || res.writableEnded;

  const sendError = async (stageLabel, err) => {
    console.error(`[upload-stream] Error during "${stageLabel}":`, err);
    if (!shouldAbort()) {
      await sendEvent({
        stage: 'error',
        label: `Failed during ${stageLabel}`,
        error: true,
        message: err.message || String(err)
      });
    }
    if (!res.writableEnded) res.end();
  };

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  const heartbeat = setInterval(() => {
    if (!shouldAbort()) {
      res.write(': keepalive\n\n');
      if (typeof res.flush === 'function') res.flush();
    } else {
      clearInterval(heartbeat);
    }
  }, 15000);

  res.on('close', () => { clearInterval(heartbeat); });
  res.on('finish', () => { clearInterval(heartbeat); });

  try {
    if (!req.file) {
      if (isSSE) return sendError('upload', new Error('No PDF file received'));
      return res.status(400).json({ success: false, error: 'No PDF file uploaded.' });
    }

    const { filename, path: filePath, originalname } = req.file;

    // ── Stage 1: Extraction ──────────────────────────────────────────────────
    if (isSSE) await sendEvent({ stage: 'parsing', label: 'Parsing PDF...', percent: 15 });
    if (shouldAbort()) return;

    const rawText = await extractTextFromPDF(filePath);
    if (!rawText || rawText.length < 500) throw new Error('PDF contains too little text.');

    // ── Stage 2: Cleaning ────────────────────────────────────────────────────
    if (isSSE) await sendEvent({ stage: 'cleaning', label: 'Cleaning text...', percent: 30 });
    if (shouldAbort()) return;

    const cleanedText = cleanText(rawText);
    const metadata = extractMetadata(cleanedText, originalname);

    // ── Stage 3: Sections ────────────────────────────────────────────────────
    if (isSSE) await sendEvent({ stage: 'sections', label: 'Extracting sections...', percent: 45 });
    if (shouldAbort()) return;

    const sections = extractSections(cleanedText);
    
    function assignSectionToChunk(chunkText, sections) {
      for (const [sectionName, sectionText] of Object.entries(sections)) {
        if (sectionText && chunkText && sectionText.includes(chunkText.slice(0, 50))) {
          return sectionName;
        }
      }
      return null;
    }

    // ── Stage 4: Chunking ────────────────────────────────────────────────────
    if (isSSE) await sendEvent({ stage: 'chunking', label: 'Chunking content...', percent: 60 });
    if (shouldAbort()) return;

    const chunks = chunkText(cleanedText).map(chunk => ({
      chunkIndex: chunk.chunkIndex,
      chunkText: chunk.text,
      sectionName: assignSectionToChunk(chunk.text, sections)
    }));

    const rawPaperJSON = {
      paperId: metadata.source.sourceName.toLowerCase() + '_' + filename.replace('.pdf', ''),
      title: metadata.title,
      year: metadata.year,
      source: metadata.source,
      authors: metadata.authors,
      sections,
      chunks,
      fullTextLength: cleanedText.length,
      rawFileName: filename
    };

    const normalizedPaper = normalizePaperJSON(rawPaperJSON);
    validatePaperJSON(normalizedPaper);
    normalizedPaper.userId = req.user.userId;
    const { paperId, title, year, source, authors, userId } = normalizedPaper;

    // ── Stage 5: Indexing (FAISS) ───────────────────────────────────────────
    if (isSSE) await sendEvent({ stage: 'indexing', label: 'Building vector index...', percent: 75 });
    if (shouldAbort()) return;

    await indexChunks(chunks, paperId);
    // Warm up immediately so first user query is fast
    warmUpIndex(paperId).catch(() => {}); // Fire and forget — don't await

    // Build Knowledge Graph
    await runQuery(`MERGE (p:ResearchPaper {paperId: $paperId}) SET p.title = $title, p.year = $year, p.userId = $userId`, { paperId, title, year, userId });
    if (source) {
      await runQuery(`MERGE (s:Source {sourceName: $name}) SET s.sourceURL = $url`, { name: source.sourceName, url: source.sourceURL });
      await runQuery(`MATCH (p:ResearchPaper {paperId: $paperId}) MATCH (s:Source {sourceName: $name}) MERGE (p)-[:SOURCED_FROM]->(s)`, { paperId, name: source.sourceName });
    }
    for (const author of authors) {
      await runQuery(`MERGE (a:Author {authorName: $name}) SET a.affiliation = $affiliation`, { name: author.authorName, affiliation: author.affiliation });
      await runQuery(`MATCH (p:ResearchPaper {paperId: $paperId}) MATCH (a:Author {authorName: $name}) MERGE (p)-[:WRITTEN_BY]->(a)`, { paperId, name: author.authorName });
    }
    for (const [sName, sText] of Object.entries(sections)) {
      await runQuery(`MERGE (s:Section {sectionName: $name}) SET s.sectionText = $text`, { name: sName, text: sText });
      await runQuery(`MATCH (p:ResearchPaper {paperId: $paperId}) MATCH (s:Section {sectionName: $name}) MERGE (p)-[:HAS_SECTION]->(s)`, { paperId, name: sName });
    }
    for (const chunk of chunks) {
      await runQuery(`MERGE (c:Chunk {paperId: $paperId, chunkIndex: $index}) SET c.chunkText = $text`, { paperId, index: chunk.chunkIndex, text: chunk.chunkText });
      await runQuery(`MATCH (p:ResearchPaper {paperId: $paperId}) MATCH (c:Chunk {paperId: $paperId, chunkIndex: $index}) MERGE (p)-[:HAS_CHUNK]->(c)`, { paperId, index: chunk.chunkIndex });
      if (chunk.sectionName) {
        await runQuery(`MATCH (c:Chunk {paperId: $paperId, chunkIndex: $index}) MATCH (s:Section {sectionName: $section}) MERGE (c)-[:REPRESENTS_PART_OF]->(s)`, { paperId, index: chunk.chunkIndex, section: chunk.sectionName });
      }
    }

    // ── Stage 6: Summarizing (AI) ────────────────────────────────────────────
    if (isSSE) await sendEvent({ stage: 'summarizing', label: 'Generating AI summaries...', percent: 90, note: 'This may take 30–60s for longer papers.' });
    if (shouldAbort()) return;

    const abstractChunk = chunks.find(c => c.sectionName === 'abstract') || chunks[0];
    const conclusionChunk = chunks.find(c => c.sectionName === 'conclusion') || chunks[chunks.length - 1];
    const summaryContext = (abstractChunk === conclusionChunk ? [abstractChunk] : [abstractChunk, conclusionChunk]).map(c => ({
        title, year, section: c.sectionName || "Intro/Outro", chunkText: c.chunkText
    }));
    
    const summaryPreview = await generateStructuredSummary(summaryContext);
    
    const summarizedSections = {};
    for (const [sName, sText] of Object.entries(sections)) {
      if (shouldAbort()) return;
      if (sText && sText.length > 50) {
        summarizedSections[sName] = await summarizePaperSection(sName, sText);
      } else {
        summarizedSections[sName] = sText;
      }
    }
    
    normalizedPaper.sections = summarizedSections;
    normalizedPaper.summaryPreview = summaryPreview;
    
    // AI Tags Generation & Meta persistence
    const tags = await generatePaperTags(normalizedPaper);
    normalizedPaper.tags = tags;
    await updatePaperMeta(paperId, userId, { tags, summary: summaryPreview });
    
    // ── Done ──────────────────────────────────────────────────────────────────
    const outPath = path.join(OUTPUT_DIR, `${paperId}.json`);
    fs.writeFileSync(outPath, JSON.stringify(normalizedPaper, null, 2));

    if (isSSE) {
      await sendEvent({ stage: 'done', label: 'Complete!', percent: 100, paperId });
      // Final keep-alive clear not strictly needed as it clears on close/end
      res.end();
    } else {
      res.json({ success: true, paperId, title, summaryPreview });
    }

  } catch (error) {
    if (isSSE) await sendError('processing', error);
    else res.status(500).json({ success: false, error: error.message });
  } finally {
    // Note: We no longer delete the raw file here so that the download feature works.
    // Railway ephemeral storage will clean up these files on redeploy.
  }
}

module.exports = { uploadPaper };
