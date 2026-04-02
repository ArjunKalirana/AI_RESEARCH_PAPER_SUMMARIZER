const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data/processed_papers');

async function getSummary(req, res) {
  try {
    const { paperId } = req.params;
    
    // Validate paperId
    if (!paperId || typeof paperId !== 'string') {
      return res.status(400).json({ error: 'Invalid paper ID' });
    }

    // Sanitize to prevent path traversal
    const cleanPaperId = path.basename(paperId);
    const filePath = path.join(DATA_DIR, `${cleanPaperId}.json`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Paper summary not found' });
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const paperData = JSON.parse(fileContent);

    if (req.isGuest) {
      if (req.shareContext.paperId !== cleanPaperId) return res.status(403).json({ error: 'Out of scope for this share token.' });
      if (req.shareContext.permissions.canView !== true) return res.status(403).json({ error: 'View permission denied.' });
    } else {
      if (paperData.userId !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });
    }

    // Filter fields to avoid sending unnecessary large data like all raw chunks
    const responsePayload = {
      title: paperData.title,
      authors: paperData.authors,
      year: paperData.year,
      summary: paperData.summaryPreview || "No summary available.",
      sections: paperData.sections,
      chunkCount: paperData.chunks?.length || 0,
      sectionCount: Object.keys(paperData.sections || {}).length,
      fullTextLength: paperData.fullTextLength || 0,
      estimatedReadTime: Math.ceil((paperData.fullTextLength || 0) / 1500),
    };

    res.json(responsePayload);
    
    // Warm up immediately so first user query is fast
    const { warmUpIndex } = require('../services/faissService');
    warmUpIndex(cleanPaperId).catch(() => {}); // Fire and forget
  } catch (error) {
    console.error('❌ Summary Route Error:', error);
    res.status(500).json({ error: 'Failed to retrieve paper summary' });
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
  downloadPaper,
  streamCritique,
  getFlashcards
};
