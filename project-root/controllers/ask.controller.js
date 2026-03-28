const fs = require('fs');
const path = require('path');
const { searchQuery, computeSimilarity } = require('../services/faissService');
const { runQuery } = require('../services/neo4j.service');
const { generateSummary, rewriteQuery, generateFollowUpSuggestions } = require('../services/llmService');
const { getChatHistory, addMessageToHistory } = require('../services/sessionService');

const processedPath = path.join(__dirname, '../data/processed_papers');

/* ================================
   Retrieval Evaluation
================================ */
async function evaluateRetrieval(query, hybridContext) {
  if (hybridContext.length === 0) {
    return { precision: "0.00", totalRetrieved: 0, relevantChunks: 0 };
  }
  
  let totalSim = 0;
  const simResults = await Promise.all(
    hybridContext.map(c => computeSimilarity(query, c.chunkText))
  );
  
  simResults.forEach(res => { totalSim += res.similarity; });
  const avgSim = totalSim / hybridContext.length;

  return {
    totalRetrieved: hybridContext.length,
    relevantChunks: hybridContext.length,
    precision: avgSim.toFixed(2)
  };
}

async function evaluateFaithfulness(summary, hybridContext) {
  const summaryText = typeof summary === 'string' ? summary : (summary?.answer || '');
  if (hybridContext.length === 0 || !summaryText ||
      summaryText.includes("not confident enough") ||
      summaryText.includes("I cannot answer this")) {
    return { groundingScore: "0.00" };
  }

  const contextText = hybridContext.map(c => c.chunkText).join(" ");
  const simRes = await computeSimilarity(summaryText, contextText);
  return { groundingScore: simRes.similarity.toFixed(2) };
}

function getConfidenceLabel(score) {
  if (score > 0.65) return "High";
  if (score >= 0.40) return "Medium";
  return "Low";
}

/* ================================
   Main Ask Controller
================================ */
async function askQuestion(req, res) {
  let isStreamClosed = false;
  
  req.on('close', () => {
    isStreamClosed = true;
  });

  const sendSSE = (data) => {
    if (isStreamClosed || res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      // res.flush() // uncomment if using compression middleware
    } catch (e) {
      console.error("[SSE] Write failed:", e.message);
    }
  };

  try {
    const { paperId, question } = req.body;

    if (!paperId || !question) {
      return res.status(400).json({ error: 'paperId and question are required' });
    }

    // ── Headers ──────────────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 🚀 CRITICAL for Nginx/AWS
    res.flushHeaders();

    const chatHistory = await getChatHistory(paperId);
    const refinedQuery = await rewriteQuery(question, chatHistory);

    // ── Retrieval ────────────────────────────────────────────────────────────
    const searchResult = await searchQuery(refinedQuery, paperId, 6);
    
    const hybridContext = [];
    const sourceTracker = new Set();
    const sources = [];

    const paperFile = `${paperId}.json`;
    const paperPath = path.join(processedPath, paperFile);
    
    if (fs.existsSync(paperPath)) {
        const paper = JSON.parse(fs.readFileSync(paperPath, 'utf-8'));
        const sortedChunks = [...paper.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);

        // ✅ HANDLE BOTH: Basic FAISS format OR Reranker result format
        if (searchResult.results && searchResult.results.length > 0) {
            // RERANKER PATH
            for (const res of searchResult.results) {
                hybridContext.push({
                    paperId,
                    title: paper.title || "Paper",
                    chunkText: res.text,
                    section: res.sectionName || "Context"
                });
                const sName = res.sectionName || "Document";
                if (!sourceTracker.has(sName)) {
                    sourceTracker.add(sName);
                    sources.push(sName);
                }
            }
        } else {
            // BASIC SEARCH PATH
            const allIndices = Array.isArray(searchResult.indices) ? (Array.isArray(searchResult.indices[0]) ? searchResult.indices[0] : searchResult.indices) : [];
            const allDistances = Array.isArray(searchResult.distances) ? (Array.isArray(searchResult.distances[0]) ? searchResult.distances[0] : searchResult.distances) : [];

            for (let i = 0; i < allIndices.length; i++) {
                const idx = allIndices[i];
                const sim = allDistances[i];
                const chunk = sortedChunks[idx];
                if (!chunk || sim < 0.20) continue;

                hybridContext.push({
                  paperId,
                  title: paper.title || "Paper",
                  chunkText: chunk.chunkText,
                  section: chunk.sectionName || "Segment"
                });

                const sName = chunk.sectionName || "Document";
                if (!sourceTracker.has(sName)) {
                    sourceTracker.add(sName);
                    sources.push(sName);
                }
            }
        }
    }

    if (hybridContext.length === 0) {
      sendSSE({ chunk: "I am not confident enough to answer this based on the paper." });
      sendSSE({ final: true, confidenceScore: 0.0, confidenceLabel: "Low", sources: [] });
      return res.end();
    }

    // ── Answer Generation ────────────────────────────────────────────────────
    const answer = await generateSummary(question, hybridContext, chatHistory, (chunk) => {
      sendSSE({ chunk });
    });

    if (isStreamClosed) return;

    // ── Parallel Post-Processing ─────────────────────────────────────────────
    const paperTitle = hybridContext[0]?.title || "Research Paper";
    const [retrievalRes, faithfulnessRes, suggestions] = await Promise.all([
      evaluateRetrieval(question, hybridContext),
      evaluateFaithfulness(answer, hybridContext),
      generateFollowUpSuggestions(question, answer, paperTitle)
    ]);

    await addMessageToHistory(paperId, "user", question);
    await addMessageToHistory(paperId, "assistant", answer);

    const finalScore = parseFloat((0.4 * parseFloat(faithfulnessRes.groundingScore) + 0.6 * parseFloat(retrievalRes.precision)).toFixed(2));

    sendSSE({
      final: true,
      confidenceScore: finalScore,
      confidenceLabel: getConfidenceLabel(finalScore),
      sources
    });
    
    sendSSE({ suggestions });
    res.end();

  } catch (error) {
    console.error('❌ Ask API Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process question' });
    } else {
      sendSSE({ error: 'An error occurred during generation.' });
      res.end();
    }
  }
}

module.exports = { askQuestion };
