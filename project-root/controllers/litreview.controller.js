const fs = require('fs');
const path = require('path');
const { generateLiteratureReview } = require('../services/llmService');

const PROCESSED_DIR = path.join(__dirname, '../data/processed_papers');

exports.generateLitReview = async (req, res) => {
  let isClosed = false;
  req.on('close', () => { isClosed = true; });
  
  try {
    const { paperIds } = req.body;
    if (!paperIds || !Array.isArray(paperIds) || paperIds.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 paper IDs.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Force TCP to send data immediately
    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setTimeout(0);
    }

    // Send initial event IMMEDIATELY to establish stream through Railway's HTTP/2 proxy
    res.write('data: {"status":"processing"}\n\n');

    // Keepalive with real data events (proxies may strip SSE comments)
    const keepalive = setInterval(() => {
        if (!isClosed && !res.writableEnded) {
            res.write('data: {"heartbeat":true}\n\n');
        }
    }, 8000);

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
      res.write(`data: ${JSON.stringify({ warning: `Papers not found on disk (may need re-upload): ${missing.join(', ')}` })}\n\n`);
    }

    if (contextParts.length < 2) {
      clearInterval(keepalive);
      res.write(`data: ${JSON.stringify({ error: 'Not enough papers with processable data. Please re-upload the missing papers.' })}\n\n`);
      return res.end();
    }

    clearInterval(keepalive); // LLM streaming takes over keepalive duty

    await generateLiteratureReview(contextParts, (chunk) => {
      if (!isClosed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      }
    });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[LitReview] Error:', err);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
};
