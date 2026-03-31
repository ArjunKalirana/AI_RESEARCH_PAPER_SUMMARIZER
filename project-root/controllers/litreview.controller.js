const fs = require('fs');
const path = require('path');
const { generateLiteratureReview } = require('../services/llmService');

const PROCESSED_DIR = path.join(__dirname, '../data/processed_papers');

exports.generateLitReview = async (req, res) => {
  try {
    const { paperIds, socketId } = req.body;
    const io = req.app.get('io');

    if (!paperIds || !Array.isArray(paperIds) || paperIds.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 paper IDs.' });
    }

    if (!socketId) {
        return res.status(400).json({ error: 'socketId is required for streaming.' });
    }

    const sendSocket = (event, data) => {
        if (io) io.to(socketId).emit(event, data);
    };

    // Acknowledge request
    res.json({ success: true, message: "Literature Review started." });

    sendSocket('litreview:status', { status: 'processing', message: 'Synthesizing selected papers...' });
    console.log(`[LitReview] Socket.io stream started for ${socketId}`);

    const contextParts = [];
    const missing = [];

    for (const pid of paperIds) {
      const paperPath = path.join(PROCESSED_DIR, `${pid}.json`);
      if (!fs.existsSync(paperPath)) {
        missing.push(pid);
        continue;
      }
      const p = JSON.parse(fs.readFileSync(paperPath, 'utf8'));
      contextParts.push({
        title: p.title || 'Untitled',
        year: p.year,
        authors: p.authors?.map(a => a.authorName || a) || [],
        summary: (p.summaryPreview || '').slice(0, 5000),
        conclusion: (p.sections?.conclusion || p.sections?.results || '').slice(0, 5000)
      });
    }

    if (missing.length > 0) {
      sendSocket('litreview:warning', { warning: `Some papers were missing on disk: ${missing.join(', ')}` });
    }

    if (contextParts.length < 2) {
      sendSocket('litreview:error', { error: 'Not enough papers with processable data found.' });
      return;
    }

    await generateLiteratureReview(contextParts, (chunk) => {
        sendSocket('litreview:chunk', { chunk });
    });

    sendSocket('litreview:final', { done: true });
    console.log(`✅ [LitReview] Review completed for ${socketId}`);

  } catch (err) {
    console.error('[LitReview] Error:', err);
    if (req.body?.socketId) {
        const io = req.app.get('io');
        io.to(req.body.socketId).emit('litreview:error', { error: err.message });
    }
  }
};
