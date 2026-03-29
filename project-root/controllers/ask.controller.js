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
    } catch (e) {
      console.error("[SSE] Write failed:", e.message);
    }
  };

  try {
    const { paperId, paperIds: rawPaperIds, question } = req.body || {};
    
    // Support both single and multi-paper mode
    let targetPaperIds = rawPaperIds && Array.isArray(rawPaperIds) && rawPaperIds.length > 0
      ? rawPaperIds
      : paperId ? [paperId] : [];

    if (targetPaperIds.length === 0 || !question) {
      return res.status(400).json({ error: 'paperId (or paperIds array) and question are required. Send Content-Type: application/json.' });
    }

    // ── Headers ──────────────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); 
    res.flushHeaders();

    // Generate unique session ID for multi-paper chat history
    const sessionId = targetPaperIds.sort().join('_');
    const chatHistory = await getChatHistory(sessionId);
    const refinedQuery = await rewriteQuery(question, chatHistory);

    // ── Retrieval ────────────────────────────────────────────────────────────
    const hybridContext = [];
    const sourceTracker = new Set();
    const sources = [];

    // Parallel search across all papers
    const searchResults = await Promise.all(
      targetPaperIds.map(id => searchQuery(refinedQuery, id, targetPaperIds.length > 1 ? 3 : 6).catch(e => {
        console.error(`Search failed for ${id}:`, e.message);
        return { results: [], indices: [], distances: [] };
      }))
    );

    for (let i = 0; i < targetPaperIds.length; i++) {
        const id = targetPaperIds[i];
        const result = searchResults[i];
        const paperPath = path.join(processedPath, `${id}.json`);
        
        if (!fs.existsSync(paperPath)) continue;
        const paper = JSON.parse(fs.readFileSync(paperPath, 'utf-8'));

        if (result.results && result.results.length > 0) {
            for (const res of result.results) {
                hybridContext.push({
                    paperId: id,
                    title: paper.title || "Paper",
                    chunkText: res.text,
                    section: res.sectionName || "Context"
                });
                const sLabel = targetPaperIds.length > 1 ? `${paper.title}: ${res.sectionName || 'Document'}` : (res.sectionName || "Document");
                if (!sourceTracker.has(sLabel)) {
                    sourceTracker.add(sLabel);
                    sources.push(sLabel);
                }
            }
        } else {
            const allIndices = Array.isArray(result.indices) ? (Array.isArray(result.indices[0]) ? result.indices[0] : result.indices) : [];
            const allDistances = Array.isArray(result.distances) ? (Array.isArray(result.distances[0]) ? result.distances[0] : result.distances) : [];
            const sortedChunks = [...paper.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);

            for (let j = 0; j < allIndices.length; j++) {
                const idx = allIndices[j];
                const sim = allDistances[j];
                const chunk = sortedChunks[idx];
                if (!chunk || sim < 0.20) continue;

                hybridContext.push({
                  paperId: id,
                  title: paper.title || "Paper",
                  chunkText: chunk.chunkText,
                  section: chunk.sectionName || "Segment"
                });

                const sLabel = targetPaperIds.length > 1 ? `${paper.title}: ${chunk.sectionName || 'Document'}` : (chunk.sectionName || "Document");
                if (!sourceTracker.has(sLabel)) {
                    sourceTracker.add(sLabel);
                    sources.push(sLabel);
                }
            }
        }
    }

    if (hybridContext.length === 0) {
      sendSSE({ chunk: "I am not confident enough to answer this based on the paper context." });
      sendSSE({ final: true, confidenceScore: 0.0, confidenceLabel: "Low", sources: [] });
      return res.end();
    }

    // ── Answer Generation ────────────────────────────────────────────────────
    // If multi-paper, use generateComparison for better citation formatting
    const genFunc = targetPaperIds.length > 1 ? generateSummary : generateSummary;
    // Actually, generateSummary is already good enough if we label the blocks.
    // Tweak context blocks to include title for the LLM
    const contextForLLM = hybridContext.map(c => ({
      ...c,
      section: targetPaperIds.length > 1 ? `Paper: "${c.title}" | Section: ${c.section}` : c.section
    }));

    const answer = await generateSummary(question, contextForLLM, chatHistory, (chunk) => {
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

    await addMessageToHistory(sessionId, "user", question);
    await addMessageToHistory(sessionId, "assistant", answer);

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
