const fs = require('fs');
const path = require('path');
const { searchQuery } = require('../services/faissService');
const { runQuery } = require('../services/neo4j.service');
const { generateSummary } = require('../services/llmService');

const vectorMapPath = path.join(__dirname, '../data/vector_map.json');
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
function evaluateRetrieval(query, hybridContext) {
  const keywords = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  let relevantCount = 0;

  hybridContext.forEach(c => {
    const text = c.chunkText.toLowerCase();
    // Relax the match from checking if SOME keywords match, to checking if AT LEAST ONE meaningful keyword is in text
    if (keywords.length === 0 || keywords.some(k => text.includes(k))) {
      relevantCount++;
    }
  });

  return {
    totalRetrieved: hybridContext.length,
    relevantChunks: relevantCount,
    precision: hybridContext.length === 0 ? "0.00" : (relevantCount / hybridContext.length).toFixed(2)
  };
}

/* ================================
   Faithfulness Evaluation
================================ */
function evaluateFaithfulness(summary, hybridContext) {
  const contextText = hybridContext.map(c => c.chunkText).join(" ").toLowerCase();
  const summaryWords = summary.toLowerCase().split(/\W+/).filter(w => w.length > 6 && !["answer", "question", "context"].includes(w));
  const hallucinatedWords = summaryWords.filter(word => !contextText.includes(word));

  return {
    hallucinationCount: hallucinatedWords.length,
    hallucinationRatio: summaryWords.length === 0 ? "0.00" : (hallucinatedWords.length / summaryWords.length).toFixed(2),
    sample: hallucinatedWords.slice(0, 6)
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
    const { paperId, question } = req.body;

    if (!paperId || !question) {
      return res.status(400).json({ error: 'paperId and question are required' });
    }

    // 1️⃣ Run Hybrid Retrieval (FAISS Search)
    const searchResult = await searchQuery(question);
    const allIndices = searchResult.indices[0]; 
    const allDistances = searchResult.distances[0];

    let vectorMap = [];
    if (fs.existsSync(vectorMapPath)) {
      vectorMap = JSON.parse(fs.readFileSync(vectorMapPath));
    }

    const hybridContext = [];
    const sourceTracker = new Set();
    const sources = [];
    const validDistances = [];

    // Filter vector mapping to get context for paperId
    for (let i = 0; i < allIndices.length; i++) {
        const idx = allIndices[i];
        const match = vectorMap.find(v => v.faissIndex === idx && v.paperId === paperId);
        
        if (!match) continue; // Not from this paper, ignore
    
        const paperFile = `${match.paperId}.json`;
        const paperPath = path.join(processedPath, paperFile);
        
        if (!fs.existsSync(paperPath)) continue;
        
        const paper = JSON.parse(fs.readFileSync(paperPath, 'utf-8'));
        const chunk = paper.chunks.find(c => c.chunkIndex === match.chunkIndex);
    
        if (!chunk) continue;
    
        // Fetch metadata from Neo4j
        const graphRes = await runQuery(`
          MATCH (p:ResearchPaper {paperId: $paperId})
          OPTIONAL MATCH (p)-[:WRITTEN_BY]->(a:Author)
          RETURN p.title AS title, p.year AS year, collect(a.authorName) AS authors
        `, { paperId: match.paperId });
    
        const graphData = graphRes.records[0]?.toObject();
    
        hybridContext.push({
          paperId: match.paperId,
          title: graphData?.title || paper.title || "Unknown",
          year: graphData?.year || paper.year || "Unknown",
          authors: graphData?.authors || paper.authors || [],
          section: match.sectionName || chunk.sectionName || "Unknown",
          chunkText: extractKeySentences(chunk.chunkText, question)
        });

        // Track sources
        const sourceName = match.sectionName ? `Section: ${match.sectionName}` : "Document";
        if (!sourceTracker.has(sourceName)) {
            sourceTracker.add(sourceName);
            sources.push(sourceName);
        }
        validDistances.push(allDistances[i]);
        if (hybridContext.length >= 5) break; 
    }

    // 2️⃣ Evaluate Retrieval
    const retrievalMetrics = evaluateRetrieval(question, hybridContext);
    const retrievalScore = parseFloat(retrievalMetrics.precision);

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
    const answer = await generateSummary(question, hybridContext);

    // 4️⃣ Evaluate Faithfulness
    const faithfulnessMetrics = evaluateFaithfulness(answer, hybridContext);

    // 5️⃣ Calculate Confidence Score
    let avgDistance = 0;
    if (validDistances.length > 0) {
        avgDistance = validDistances.reduce((a, b) => a + b, 0) / validDistances.length;
    }
    const vectorConfidence = 1 / (1 + avgDistance);
    const groundednessScore = 1 - parseFloat(faithfulnessMetrics.hallucinationRatio);

    const finalConfidence = parseFloat((
      0.5 * retrievalScore +
      0.3 * groundednessScore +
      0.2 * vectorConfidence
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
