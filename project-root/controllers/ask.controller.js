const fs = require('fs');
const path = require('path');
const { searchQuery, computeSimilarity } = require('../services/faissService');
const { runQuery } = require('../services/neo4j.service');
const { generateSummary, rewriteQuery } = require('../services/llmService');
const { getChatHistory, addMessageToHistory } = require('../services/sessionService');

const vectorMapPath = path.join(__dirname, '../data/vector_map.json'); // Deprecated
const processedPath = path.join(__dirname, '../data/processed_papers');

/* ================================
   Removed: Extractive Compression 
   (Handled dynamically by prompt token limits)
================================ */

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
    relevantChunks: hybridContext.length, // All are considered 'retrieved' context
    precision: avgSim.toFixed(2) // We use semantic similarity as precision
  };
}

/* ================================
   Faithfulness Evaluation
================================ */
async function evaluateFaithfulness(summary, hybridContext) {
  // summary is now a plain string
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

/* ================================
   Category determination
================================ */
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

    // Initialize SSE Headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Retrieve active sliding window memory
    const chatHistory = await getChatHistory(paperId);

    // 1️⃣ Rewrite Query (Resolve Anaphora from Chat History)
    const refinedQuery = await rewriteQuery(question, chatHistory);

    // 2️⃣ Run Hybrid Retrieval (FAISS Search - isolated index for this paper)
    const searchResult = await searchQuery(refinedQuery, paperId, 6);
    const allIndices = searchResult.indices[0] || []; 
    const allDistances = searchResult.distances[0] || [];

    const hybridContext = [];
    const sourceTracker = new Set();
    const sources = [];
    const validDistances = [];

    const paperFile = `${paperId}.json`;
    const paperPath = path.join(processedPath, paperFile);
    
    if (fs.existsSync(paperPath)) {
        const paper = JSON.parse(fs.readFileSync(paperPath, 'utf-8'));
        
        // Fetch metadata from Neo4j once optimally
        const graphRes = await runQuery(`
          MATCH (p:ResearchPaper {paperId: $paperId})
          OPTIONAL MATCH (p)-[:WRITTEN_BY]->(a:Author)
          RETURN p.title AS title, p.year AS year, collect(a.authorName) AS authors
        `, { paperId });
        
        const graphData = graphRes.records[0]?.toObject();

        const sortedChunks = [...paper.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);

        for (let i = 0; i < allIndices.length; i++) {
            const faissRowIndex = allIndices[i];
            
            // ✅ FIX 1: Direct position mapping — no more .find() mismatch
            const chunk = sortedChunks[faissRowIndex];
            if (!chunk) continue;
            
            // Filter out noise chunks — raised from 0.15 to 0.25 to reduce LLM confusion
            const similarity = allDistances[i];
            if (similarity < 0.25) continue;

            hybridContext.push({
              paperId: paperId,
              title: graphData?.title || paper.title || "Unknown",
              year: graphData?.year || paper.year || "Unknown",
              authors: graphData?.authors || paper.authors || [],
              
              // ✅ FIX 3: Section name inference if missing
              section: chunk.sectionName && chunk.sectionName.trim().length > 0
                ? chunk.sectionName
                : inferSectionName(chunk.chunkIndex, sortedChunks.length),
              
              // ✅ FIX 2: NO extractive compression — send full chunk text to LLM
              chunkText: chunk.chunkText
            });

            // Track sources
            const sourceName = chunk.sectionName ? `Section: ${chunk.sectionName}` : "Document";
            if (!sourceTracker.has(sourceName)) {
                sourceTracker.add(sourceName);
                sources.push(sourceName);
            }
            validDistances.push(similarity);
            if (hybridContext.length >= 6) break; 
        }
    }

    // 2️⃣ Evaluate Retrieval
    const retrievalMetrics = await evaluateRetrieval(question, hybridContext);
    const retrievalScore = parseFloat(retrievalMetrics.precision); // This is now average similarity

    // Fallback if no relevant passages are found at all in the paper
    if (hybridContext.length === 0) {
      const fallbackMsg = "I am not confident enough to answer this question based on the uploaded paper, as no relevant sections were found.";
      res.write(`data: ${JSON.stringify({ chunk: fallbackMsg })}\n\n`);
      res.write(`data: ${JSON.stringify({ 
        final: true, 
        confidenceScore: 0.0, 
        confidenceLabel: "Low", 
        sources: [] 
      })}\n\n`);
      return res.end();
    }

    // 3️⃣ Generate LLM Answer (Streaming)
    const answer = await generateSummary(question, hybridContext, chatHistory, (chunk) => {
      // Stream each word directly to the client as it generates
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    });

    // Update in-memory sliding window history
    await addMessageToHistory(paperId, "user", question);
    await addMessageToHistory(paperId, "assistant", answer);

    // 4️⃣ Evaluate Faithfulness
    const faithfulnessMetrics = await evaluateFaithfulness(answer, hybridContext);

    // 5️⃣ Calculate Confidence Score
    // Formula: 0.4 * Semantic Grounding + 0.6 * Context Relevance
    // contextRelevance weighted higher — it reflects retrieval quality, not just answer similarity
    const semanticGrounding = faithfulnessMetrics.groundingScore ? parseFloat(faithfulnessMetrics.groundingScore) : 0;
    const contextRelevance = Math.max(0, retrievalScore);

    const finalConfidence = parseFloat((
      0.4 * semanticGrounding +
      0.6 * contextRelevance
    ).toFixed(2));

    const confidenceLabel = getConfidenceLabel(finalConfidence);

    // 6️⃣ Send Final Event with Metadata
    res.write(`data: ${JSON.stringify({
      final: true,
      confidenceScore: finalConfidence,
      confidenceLabel,
      sources
    })}\n\n`);
    
    res.end();

  } catch (error) {
    console.error('❌ Ask API Error:', error);
    // Only send error if headers haven't been sent, otherwise end stream
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process question' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'An error occurred during generation.' })}\n\n`);
      res.end();
    }
  }
}

// ============================================================
// FIX 3: Section name inference
// If the PDF parser failed to extract section names,
// infer a reasonable label based on chunk position in document.
// Better than hardcoding everything as "introduction".
// ============================================================
function inferSectionName(chunkIndex, totalChunks) {
  const position = chunkIndex / totalChunks;
  if (position < 0.1) return "Abstract / Introduction";
  if (position < 0.25) return "Introduction";
  if (position < 0.5) return "Methodology";
  if (position < 0.75) return "Results / Discussion";
  return "Conclusion / References";
}

module.exports = {
  askQuestion
};
