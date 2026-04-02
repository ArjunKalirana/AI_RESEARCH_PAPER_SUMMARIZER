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
      if (!fs.existsSync(paperPath)) { missing.push(pid); continue; }
      const p = JSON.parse(fs.readFileSync(paperPath, 'utf8'));

      // Ownership check — papers without userId are legacy uploads, treat as not owned
      if (!p.userId) {
        sendSocket('litreview:warning', { warning: `Paper "${p.title || pid}" has no owner record. Please re-upload it to use it in a literature review.` });
        continue;
      }
      if (p.userId !== req.user.userId) {
        sendSocket('litreview:warning', { warning: `Forbidden: You do not own paper "${p.title || pid}". Skipping.` });
        continue;
      }
      
      const sections = p.sections || {};

      // Build a structured context object with all academically relevant parts
      contextParts.push({
        title: p.title || 'Untitled',
        year: p.year || 'n.d.',
        authors: (p.authors || []).map(a => a.authorName || a).slice(0, 3),
        abstract: (sections.abstract || p.summaryPreview || '').slice(0, 800),
        methodology: (sections.methodology || sections.methods || sections.approach || '').slice(0, 1000),
        results: (sections.results || sections.findings || sections.experiments || '').slice(0, 1000),
        conclusion: (sections.conclusion || sections.discussion || '').slice(0, 800),
        limitations: (sections.limitations || sections.futurework || sections['future work'] || '').slice(0, 600),
        // Pull key terms from tags if available
        tags: (p.tags || []).slice(0, 6),
        // Dataset/benchmark info if present in any section
        dataset: (sections.dataset || sections.data || sections.corpus || '').slice(0, 400),
      });
    }

    const loadedTitles = contextParts.map(p => `"${p.title}"`).join(', ');
    sendSocket('litreview:status', {
      status: 'generating',
      message: `Loaded ${contextParts.length} papers: ${loadedTitles}. Writing literature review...`
    });

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
