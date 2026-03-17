const fs = require('fs');
const path = require('path');
const { searchQuery, computeSimilarity } = require('../services/faissService');
const { runQuery } = require('../services/neo4j.service');
const { generateSummary, rewriteQuery, generateFollowUpSuggestions } = require('../services/llmService');
const { getChatHistory, addMessageToHistory } = require('../services/sessionService');

const vectorMapPath = path.join(__dirname, '../data/vector_map.json'); // Deprecated
const processedPath = path.join(__dirname, '../data/processed_papers');

/* ================================
   Retrieval Evaluation
================================ */
async function evaluateRetrieval(query, hybridContext) {
  if (hybridContext.length === 0) {
    return { precision: "0.00", totalRetrieved: 0, relevantChunks: 0 };
  }
  
  let totalSim = 0;
  for (const c of hybridContext) {
    const simRes = await computeSimilarity(query, c.chunkText);
    totalSim += simRes.similarity;
  }
  
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
    return { hallucinationRatio: "0.00", hallucinationCount: 0, sample: [] };
  }

  const contextText = hybridContext.map(c => c.chunkText).join(" ");
  const simRes = await computeSimilarity(summaryText, contextText);
  const groundingScore = simRes.similarity;
  
  const hallucinationRatio = Math.max(0, 1 - groundingScore);

  return {
    hallucinationCount: 0,
    hallucinationRatio: hallucinationRatio.toFixed(2),
    sample: [],
    groundingScore: groundingScore.toFixed(2)
  };
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
    const refinedQuery = await rewriteQuery(question, chatHistory);
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

        // Indices/Distances from reranker might be flat array or nested
        const flatIndices = Array.isArray(allIndices[0]) ? allIndices[0] : allIndices;
        const flatDistances = Array.isArray(allDistances[0]) ? allDistances[0] : allDistances;

        for (let i = 0; i < flatIndices.length; i++) {
            const index = flatIndices[i];
            const similarity = flatDistances[i];
            
            // Check if it's a direct chunk (from reranker results)
            let chunk = sortedChunks[index];
            
            // If the search result has no index mapping but has text (reranker style)
            if (searchResult.results && searchResult.results[i]) {
                const res = searchResult.results[i];
                chunk = { chunkText: res.text, sectionName: res.sectionName || "Section" };
            }

            if (!chunk) continue;
            if (similarity < 0.20) continue; 

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
      const fallbackMsg = "I am not confident enough to answer this question based on the uploaded paper.";
      res.write(`data: ${JSON.stringify({ chunk: fallbackMsg })}\n\n`);
      res.write(`data: ${JSON.stringify({ final: true, confidenceScore: 0.0, confidenceLabel: "Low", sources: [] })}\n\n`);
      return res.end();
    }

    // 3️⃣ Generate LLM Answer (Streaming)
    const answer = await generateSummary(question, hybridContext, chatHistory, (chunk) => {
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    });

    await addMessageToHistory(paperId, "user", question);
    await addMessageToHistory(paperId, "assistant", answer);

    const retrievalMetrics = await evaluateRetrieval(question, hybridContext);
    const faithfulnessMetrics = await evaluateFaithfulness(answer, hybridContext);

    const finalConfidence = parseFloat((0.4 * (faithfulnessMetrics.groundingScore || 0) + 0.6 * parseFloat(retrievalMetrics.precision)).toFixed(2));
    const confidenceLabel = getConfidenceLabel(finalConfidence);

    // 6️⃣ Send Final Event with Metadata
    res.write(`data: ${JSON.stringify({
      final: true,
      confidenceScore: finalConfidence,
      confidenceLabel,
      sources
    })}\n\n`);
    
    // 7️⃣ Generate and Send Follow-up Suggestions (NEW)
    const paperTitle = hybridContext[0]?.title || "Research Paper";
    const suggestions = await generateFollowUpSuggestions(question, answer, paperTitle);
    
    res.write(`data: ${JSON.stringify({ suggestions })}\n\n`);
    
    res.end();

  } catch (error) {
    console.error('❌ Ask API Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process question' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'An error occurred during generation.' })}\n\n`);
      res.end();
    }
  }
}

function inferSectionName(chunkIndex, totalChunks) {
  const position = chunkIndex / totalChunks;
  if (position < 0.1) return "Abstract / Introduction";
  if (position < 0.25) return "Introduction";
  if (position < 0.5) return "Methodology";
  if (position < 0.75) return "Results / Discussion";
  return "Conclusion / References";
}

module.exports = { askQuestion };
