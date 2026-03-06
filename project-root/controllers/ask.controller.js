const fs = require('fs');
const path = require('path');
const { searchQuery, computeSimilarity } = require('../services/faissService');
const { runQuery } = require('../services/neo4j.service');
const { generateSummary } = require('../services/llmService');

const vectorMapPath = path.join(__dirname, '../data/vector_map.json'); // Deprecated
const processedPath = path.join(__dirname, '../data/processed_papers');

/* ================================
   Extractive Compression
================================ */
function extractKeySentences(text, query) {
  if (!text) return "";
  const sentences = text.split(/(?<=[.?!])\s+/);
  
  // Extract dynamic keywords from the user question, ignoring small unhelpful words
  const keywords = query ? query.toLowerCase().split(/\W+/).filter(w => w.length > 3) : [];

  if (keywords.length === 0) {
    // Fallback if no valid keywords: just return the first few sentences
    return sentences.slice(0, 4).join(" ");
  }

  const scored = sentences.map(s => {
    let score = 0;
    for (const k of keywords) {
      if (s.toLowerCase().includes(k)) score++;
    }
    return { sentence: s.trim(), score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(s => s.sentence)
    .join(" ");
}

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
  if (hybridContext.length === 0 || !summary || summary.includes("Not found in the paper") || summary.includes("I cannot answer this")) {
    return { hallucinationRatio: "0.00", hallucinationCount: 0, sample: [] };
  }

  const contextText = hybridContext.map(c => c.chunkText).join(" ");
  const simRes = await computeSimilarity(summary, contextText);
  const groundingScore = simRes.similarity;
  
  // Calculate a mock 'hallucination ratio' which is inverse of grounding
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
  if (score >= 0.70) return "High";
  if (score >= 0.50) return "Medium";
  return "Low";
}

/* ================================
   Main Ask Controller
================================ */
async function askQuestion(req, res) {
  try {
    const { paperId, question, chatHistory = [] } = req.body;

    if (!paperId || !question) {
      return res.status(400).json({ error: 'paperId and question are required' });
    }

    // 1️⃣ Run Hybrid Retrieval (FAISS Search - isolated index for this paper)
    const searchResult = await searchQuery(question, paperId, 6);
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

        for (let i = 0; i < allIndices.length; i++) {
            const idx = allIndices[i]; // Isolated index maps exactly to chunkIndex
            
            const chunk = paper.chunks.find(c => c.chunkIndex === idx);
            if (!chunk) continue;
            
            hybridContext.push({
              paperId: paperId,
              title: graphData?.title || paper.title || "Unknown",
              year: graphData?.year || paper.year || "Unknown",
              authors: graphData?.authors || paper.authors || [],
              section: chunk.sectionName || "Unknown",
              chunkText: extractKeySentences(chunk.chunkText, question)
            });

            // Track sources
            const sourceName = chunk.sectionName ? `Section: ${chunk.sectionName}` : "Document";
            if (!sourceTracker.has(sourceName)) {
                sourceTracker.add(sourceName);
                sources.push(sourceName);
            }
            validDistances.push(allDistances[i]);
            if (hybridContext.length >= 6) break; 
        }
    }

    // 2️⃣ Evaluate Retrieval
    const retrievalMetrics = await evaluateRetrieval(question, hybridContext);
    const retrievalScore = parseFloat(retrievalMetrics.precision); // This is now average similarity

    // Fallback if no relevant passages are found at all in the paper
    if (hybridContext.length === 0) {
      return res.json({
        answer: "I am not confident enough to answer this question based on the uploaded paper, as no relevant sections were found.",
        confidenceScore: 0.0,
        confidenceLabel: "Low",
        retrievalMetrics,
        faithfulnessMetrics: null,
        sources: []
      });
    }

    // 3️⃣ Generate LLM Answer
    const answer = await generateSummary(question, hybridContext, chatHistory);

    // 4️⃣ Evaluate Faithfulness
    const faithfulnessMetrics = await evaluateFaithfulness(answer, hybridContext);

    // 5️⃣ Calculate Confidence Score
    // New Formula: Total Confidence = 0.6 * Semantic Grounding + 0.4 * Context Relevance
    const semanticGrounding = faithfulnessMetrics.groundingScore ? parseFloat(faithfulnessMetrics.groundingScore) : 0;
    
    // Normalize retrieval score to [0,1] domain assuming it's cosine similarity
    const contextRelevance = Math.max(0, retrievalScore); 

    const finalConfidence = parseFloat((
      0.6 * semanticGrounding + 
      0.4 * contextRelevance
    ).toFixed(2));

    const confidenceLabel = getConfidenceLabel(finalConfidence);

    // 6️⃣ Return Final Response
    res.json({
      answer,
      confidenceScore: finalConfidence,
      confidenceLabel,
      retrievalMetrics,
      faithfulnessMetrics,
      sources
    });

  } catch (error) {
    console.error('❌ Ask API Error:', error);
    res.status(500).json({ error: 'Failed to process question' });
  }
}

module.exports = {
  askQuestion
};
