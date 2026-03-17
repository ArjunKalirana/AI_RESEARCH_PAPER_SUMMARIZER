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
  // Use Promise.all to avoid sequential AI calls
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

/* ================================
   Faithfulness Evaluation
================================ */
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
  
  // Safeguard: Detect client disconnect
  req.on('close', () => {
    isStreamClosed = true;
  });

  const sendSSE = (data) => {
    if (isStreamClosed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { paperId, question } = req.body;

    if (!paperId || !question) {
      return res.status(400).json({ error: 'paperId and question are required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const chatHistory = await getChatHistory(paperId);
    
    // 1️⃣ Resolve context & Retrieve
    const [refinedQuery] = await Promise.all([
        rewriteQuery(question, chatHistory)
    ]);

    const searchResult = await searchQuery(refinedQuery, paperId, 6);
    const allIndices = searchResult.indices || []; 
    const allDistances = searchResult.distances || [];

    const hybridContext = [];
    const sourceTracker = new Set();
    const sources = [];

    const paperFile = `${paperId}.json`;
    const paperPath = path.join(processedPath, paperFile);
    
    if (fs.existsSync(paperPath)) {
        const paper = JSON.parse(fs.readFileSync(paperPath, 'utf-8'));
        
        const graphRes = await runQuery(`
          MATCH (p:ResearchPaper {paperId: $paperId})
          OPTIONAL MATCH (p)-[:WRITTEN_BY]->(a:Author)
          RETURN p.title AS title, p.year AS year, collect(a.authorName) AS authors
        `, { paperId });
        
        const graphData = graphRes.records[0]?.toObject();
        const sortedChunks = [...paper.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);

        const flatIndices = Array.isArray(allIndices[0]) ? allIndices[0] : allIndices;
        const flatDistances = Array.isArray(allDistances[0]) ? allDistances[0] : allDistances;

        for (let i = 0; i < flatIndices.length; i++) {
            const index = flatIndices[i];
            const similarity = flatDistances[i];
            
            let chunk = sortedChunks[index];
            if (searchResult.results && searchResult.results[i]) {
                const rs = searchResult.results[i];
                chunk = { chunkText: rs.text, sectionName: rs.sectionName || "Section" };
            }

            if (!chunk || similarity < 0.20) continue;

            hybridContext.push({
              paperId: paperId,
              title: graphData?.title || paper.title || "Unknown",
              chunkText: chunk.chunkText,
              section: chunk.sectionName || "Segment"
            });

            const sourceName = chunk.sectionName ? `Section: ${chunk.sectionName}` : "Document";
            if (!sourceTracker.has(sourceName)) {
                sourceTracker.add(sourceName);
                sources.push(sourceName);
            }
            if (hybridContext.length >= 6) break; 
        }
    }

    if (hybridContext.length === 0) {
      sendSSE({ chunk: "I am not confident enough to answer this based on the paper." });
      sendSSE({ final: true, confidenceScore: 0.0, confidenceLabel: "Low", sources: [] });
      return res.end();
    }

    // 2️⃣ Generate LLM Answer (Streaming)
    const answer = await generateSummary(question, hybridContext, chatHistory, (chunk) => {
      sendSSE({ chunk });
    });

    if (isStreamClosed) return;

    // 3️⃣ Parallel Post-Processing (Optimization: Run evaluations and suggestions together)
    const paperTitle = hybridContext[0]?.title || "Research Paper";
    
    console.log("🚀 Starting parallel post-processing...");
    const [retrievalRes, faithfulnessRes, suggestions] = await Promise.all([
      evaluateRetrieval(question, hybridContext),
      evaluateFaithfulness(answer, hybridContext),
      generateFollowUpSuggestions(question, answer, paperTitle)
    ]);

    // Update History
    await addMessageToHistory(paperId, "user", question);
    await addMessageToHistory(paperId, "assistant", answer);

    // Confidence Logic
    const finalConfidence = parseFloat((0.4 * parseFloat(faithfulnessRes.groundingScore) + 0.6 * parseFloat(retrievalRes.precision)).toFixed(2));
    const confidenceLabel = getConfidenceLabel(finalConfidence);

    // 4️⃣ Final Events
    sendSSE({
      final: true,
      confidenceScore: finalConfidence,
      confidenceLabel,
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
