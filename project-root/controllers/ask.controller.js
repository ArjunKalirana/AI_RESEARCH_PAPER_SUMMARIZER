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
  const count = hybridContext.length;
  if (count === 0) return { precision: "0.00", avgScore: 0 };
  
  const scores = hybridContext.map(c => c.score || 0).filter(s => s > 0);
  const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length) : 0.2;
  
  let precision = Math.min(1.0, (count / 6) * avgScore * 1.5);
  
  return {
    totalRetrieved: count,
    avgScore: avgScore.toFixed(2),
    precision: precision.toFixed(2)
  };
}

async function evaluateFaithfulness(summary, hybridContext) {
  if (!hybridContext.length || !summary) return { groundingScore: "0.00" };
  const text = (summary || "").toLowerCase();
  
  const refusalPhrases = [
    "i don't find", "i do not find", "not mentioned", "not discussed", 
    "no information", "cannot answer", "i am sorry", "i'm sorry",
    "does not provide", "does not contain", "information is not available",
    "the provided context does not", "not specifically mentioned"
  ];
  
  const isRefusal = refusalPhrases.some(phrase => text.includes(phrase));
  if (isRefusal) {
    return { groundingScore: "0.10", refusal: true };
  }

  const contextLen = hybridContext.reduce((sum, c) => sum + (c.chunkText || "").length, 0);
  const densityScore = Math.min(0.95, 0.4 + (contextLen / 10000) * 0.5);
  return { groundingScore: densityScore.toFixed(2) };
}

function getConfidenceLabel(score) {
  if (score > 0.70) return "High";
  if (score >= 0.40) return "Medium";
  return "Low";
}

/* ================================
   Main Ask Controller
 ================================ */
async function askQuestion(req, res) {
  try {
    const { socketId, paperId, paperIds: rawPaperIds, question } = req.body || {};
    const io = req.app.get('io');
    
    if (!socketId) {
      return res.status(400).json({ error: 'socketId is required for streaming.' });
    }
    
    let targetPaperIds = rawPaperIds && Array.isArray(rawPaperIds) && rawPaperIds.length > 0
      ? rawPaperIds
      : paperId ? [paperId] : [];

    if (req.isGuest) {
      if (!req.shareContext.permissions.canChat) {
         return res.status(403).json({ error: 'Chat is disabled for this share link.' });
      }
      targetPaperIds = [req.shareContext.paperId]; // Force single valid paper ID
    }

    if (targetPaperIds.length === 0 || !question) {
      return res.status(400).json({ error: 'paperId (or paperIds array) and question are required.' });
    }

    const sendSocket = (event, data) => {
        if (io) io.to(socketId).emit(event, data);
    };

    res.json({ success: true, message: "Streaming started via Socket.io" });

    sendSocket('ask:status', { status: 'processing', message: 'Retrieving context...' });
    console.log(`[Ask] Socket.io stream started for ${socketId}`);

    const sessionId = targetPaperIds.sort().join('_');
    const activeUserId = req.isGuest ? `guest_${req.shareContext.paperId}` : req.user.userId;
    const chatHistory = await getChatHistory(sessionId, activeUserId);
    
    const refinedQuery = chatHistory.length > 0 
      ? await rewriteQuery(question, chatHistory)
      : question;

    const hybridContext = [];
    const sourceTracker = new Set();
    const sources = [];

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
        
        if (req.isGuest) {
            if (paper.paperId !== req.shareContext.paperId && id !== req.shareContext.paperId) {
                sendSocket('ask:error', { error: 'Forbidden: Out of scope for this share token.' });
                return;
            }
        } else {
            if (paper.userId !== req.user.userId) {
                sendSocket('ask:error', { error: 'Forbidden: You do not own this paper.' });
                return;
            }
        }

        if (result.results && result.results.length > 0) {
            for (const res of result.results) {
                hybridContext.push({
                    paperId: id,
                    title: paper.title || "Paper",
                    chunkText: res.text,
                    section: res.sectionName || "Context",
                    score: res.score || 0
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
                  section: chunk.sectionName || "Segment",
                  score: sim
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
      sendSocket('ask:results', { chunk: "I am not confident enough to answer this based on the paper context." });
      sendSocket('ask:final', { confidenceScore: 0.0, confidenceLabel: "Low", sources: [] });
      return;
    }

    const contextForLLM = hybridContext.map(c => ({
      ...c,
      section: targetPaperIds.length > 1 ? `Paper: "${c.title}" | Section: ${c.section}` : c.section
    }));

    console.log(`📊 [Ask] Retrieved ${hybridContext.length} context chunks from ${targetPaperIds.length} paper(s)`);

    const answer = await generateSummary(question, contextForLLM, chatHistory, (chunk) => {
      sendSocket('ask:chunk', { chunk });
    });

    console.log(`✅ [Ask] Answer generated: ${typeof answer === 'string' ? answer.length : 0} chars`);

    const paperTitle = hybridContext[0]?.title || "Research Paper";
    const [retrievalRes, faithfulnessRes] = await Promise.all([
      evaluateRetrieval(refinedQuery, hybridContext),
      evaluateFaithfulness(answer, hybridContext)
    ]);

    addMessageToHistory(sessionId, activeUserId, "user", question).catch(() => {});
    addMessageToHistory(sessionId, activeUserId, "assistant", answer).catch(() => {});

    const fScore = parseFloat(faithfulnessRes.groundingScore);
    const pScore = parseFloat(retrievalRes.precision);
    const finalConfidence = (0.5 * fScore + 0.5 * pScore);
    const confidenceLabel = getConfidenceLabel(finalConfidence);
    
    console.log(`[Ask] Evaluation - Score: ${finalConfidence.toFixed(2)} | Faith: ${fScore} | Precision: ${pScore} | Refusal: ${faithfulnessRes.refusal || false}`);

    sendSocket('ask:final', {
      confidenceScore: finalConfidence.toFixed(2),
      confidenceLabel: confidenceLabel,
      sources
    });

    generateFollowUpSuggestions(question, answer, paperTitle)
      .then(suggestions => {
          sendSocket('ask:suggestions', { suggestions });
      })
      .catch(() => {});

  } catch (error) {
    console.error('❌ Ask API Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process question' });
    } else {
      if (io && req.body?.socketId) {
          io.to(req.body.socketId).emit('ask:error', { error: 'An error occurred during generation.' });
      }
    }
  }
}

module.exports = { askQuestion };
