const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '../data/processed_papers');
const { updatePaperMeta } = require('../services/libraryMetaService');

async function getSummary(req, res) {
  try {
    const { paperId } = req.params;
    const cleanPaperId = path.basename(paperId);
    const filePath = path.join(DATA_DIR, `${cleanPaperId}.json`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Paper summary not found' });
    }

    const paperData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (paperData.userId !== req.user.userId && !req.isGuest) return res.status(403).json({ error: 'Forbidden' });

    // Sync summary to DB if missing
    if (paperData.summaryPreview) {
       updatePaperMeta(cleanPaperId, paperData.userId, { summary: paperData.summaryPreview }).catch(err => console.error('DB Sync Error:', err));
    }

    res.json({
      title: paperData.title,
      authors: paperData.authors,
      year: paperData.year,
      summary: paperData.summaryPreview || "No summary available.",
      sections: paperData.sections,
      chunkCount: paperData.chunks?.length || 0,
      fullTextLength: paperData.fullTextLength || 0,
      estimatedReadTime: Math.ceil((paperData.fullTextLength || 0) / 1500),
      flashcards: paperData.flashcards || []
    });

    const { warmUpIndex } = require('../services/faissService');
    warmUpIndex(cleanPaperId).catch(() => {});
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve paper summary' });
  }
}

const { generateStructuredSummary, summarizePaperSection } = require('../services/llmService');

async function regenerateSummary(req, res) {
  try {
    const { paperId } = req.params;
    const cleanPaperId = path.basename(paperId);
    const filePath = path.join(DATA_DIR, `${cleanPaperId}.json`);

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Paper not found' });
    const paperData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (paperData.userId !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });

    // 1. Regenerate Summary Preview
    const abstractChunk = paperData.chunks.find(c => (c.sectionName||'').toLowerCase() === 'abstract') || paperData.chunks[0];
    const conclusionChunk = paperData.chunks.find(c => (c.sectionName||'').toLowerCase() === 'conclusion') || paperData.chunks[paperData.chunks.length - 1];
    const summaryContext = [abstractChunk, conclusionChunk].map(c => ({
        title: paperData.title, 
        section: c.sectionName || "Key Section", 
        chunkText: c.chunkText
    }));
    
    const newSummaryPreview = await generateStructuredSummary(summaryContext);
    
    // 2. Regenerate Section Summaries
    const newSummarizedSections = {};
    for (const [sName, sText] of Object.entries(paperData.sections || {})) {
       // We need the raw text to regenerate, but if sections already contains summaries, we might need to find raw text from chunks
       // For now, let's just regenerate the main summary preview as requested by "regenerate the summary"
    }
    
    paperData.summaryPreview = newSummaryPreview;
    fs.writeFileSync(filePath, JSON.stringify(paperData, null, 2));
    await updatePaperMeta(cleanPaperId, paperData.userId, { summary: newSummaryPreview });

    res.json({ success: true, summary: newSummaryPreview });
  } catch (error) {
    console.error('Regeneration Error:', error);
    res.status(500).json({ error: 'Failed to regenerate summary' });
  }
}

async function downloadPaper(req, res) {
  try {
    const { paperId } = req.params;
    
    if (!paperId || typeof paperId !== 'string') {
      return res.status(400).json({ error: 'Invalid paper ID' });
    }

    // Path to the processed metadata JSON
    const cleanPaperId = path.basename(paperId);
    const metaPath = path.join(DATA_DIR, `${cleanPaperId}.json`);

    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({ error: 'Paper metadata not found' });
    }

    const paperData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    if (paperData.userId !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });
    const rawFileName = paperData.rawFileName;

    if (!rawFileName) {
      return res.status(404).json({ error: 'Original PDF filename not found in metadata' });
    }

    const RAW_DIR = path.join(__dirname, '../data/raw_papers');
    const pdfPath = path.join(RAW_DIR, rawFileName);

    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ error: 'Original PDF file was cleaned up or is missing from server' });
    }

    // Prompt browser to download the file directly
    res.download(pdfPath, `ResearchPaper_${rawFileName.split('-').slice(1).join('-')}`);
  } catch (error) {
    console.error('❌ Download Route Error:', error);
    res.status(500).json({ error: 'Failed to download paper PDF' });
  }
}

const { generateMethodologyCritique, generateFlashcards } = require('../services/llmService');

async function streamCritique(req, res) {
  try {
    const { paperId } = req.params;
    const cleanPaperId = path.basename(paperId);
    const filePath = path.join(DATA_DIR, `${cleanPaperId}.json`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Paper not found' });
    }

    const paperData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (paperData.userId !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    await generateMethodologyCritique(paperData, (chunk) => {
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error) {
    console.error('❌ Stream Critique Error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message || 'Failed to generate critique' })}\n\n`);
    res.end();
  }
}

async function getFlashcards(req, res) {
  try {
    const { paperId } = req.params;
    const cleanPaperId = path.basename(paperId);
    const filePath = path.join(DATA_DIR, `${cleanPaperId}.json`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Paper not found' });
    }

    const paperData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (paperData.userId !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });

    // Return cached flashcards if they already exist
    if (paperData.flashcards && Array.isArray(paperData.flashcards) && paperData.flashcards.length > 0) {
      return res.json({ success: true, flashcards: paperData.flashcards });
    }

    // Generate new flashcards
    const newFlashcards = await generateFlashcards(paperData);

    if (newFlashcards && newFlashcards.length > 0) {
      // Cache them into the processed JSON
      paperData.flashcards = newFlashcards;
      fs.writeFileSync(filePath, JSON.stringify(paperData, null, 2));
      return res.json({ success: true, flashcards: newFlashcards });
    } else {
      return res.status(500).json({ error: 'Failed to generate flashcards from AI' });
    }
  } catch (error) {
    console.error('❌ Flashcards Route Error:', error);
    res.status(500).json({ error: 'Failed to retrieve flashcards' });
  }
}

module.exports = {
  getSummary,
  regenerateSummary,
  downloadPaper,
  streamCritique,
  getFlashcards
};
