const fs = require("fs");
const path = require("path");

const { searchQuery } = require("../services/faissService");
const { runQuery } = require("../services/neo4j.service");
const { generateSummary } = require("../services/llmService");

const vectorMapPath = path.join(__dirname, "../data/vector_map.json");
const processedPath = path.join(__dirname, "../data/processed_papers");

/* ================================
   Extractive Compression
================================ */
function extractKeySentences(text) {
  const sentences = text.split(/(?<=[.?!])\s+/);

  const keywords = [
    "GPT-3",
    "few-shot",
    "zero-shot",
    "one-shot",
    "model",
    "learning"
  ];

  const scored = sentences.map(s => {
    let score = 0;
    for (const k of keywords) {
      if (s.toLowerCase().includes(k.toLowerCase())) score++;
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
  const keywords = query.toLowerCase().split(/\W+/);

  let relevantCount = 0;

  hybridContext.forEach(c => {
    const text = c.chunkText.toLowerCase();
    if (keywords.some(k => k.length > 3 && text.includes(k))) {
      relevantCount++;
    }
  });

  return {
    totalRetrieved: hybridContext.length,
    relevantChunks: relevantCount,
    precision:
      hybridContext.length === 0
        ? "0.00"
        : (
            relevantCount / hybridContext.length
          ).toFixed(2)
  };
}

/* ================================
   Faithfulness Evaluation
================================ */
function evaluateFaithfulness(summary, hybridContext) {
  const contextText = hybridContext
    .map(c => c.chunkText)
    .join(" ")
    .toLowerCase();

  const summaryWords = summary
    .toLowerCase()
    .split(/\W+/)
    .filter(
      w =>
        w.length > 6 &&
        !["answer", "question", "context"].includes(w)
    );

  const hallucinatedWords = summaryWords.filter(
    word => !contextText.includes(word)
  );

  return {
    hallucinationCount: hallucinatedWords.length,
    hallucinationRatio:
      summaryWords.length === 0
        ? "0.00"
        : (
            hallucinatedWords.length /
            summaryWords.length
          ).toFixed(2),
    sample: hallucinatedWords.slice(0, 6)
  };
}

/* ================================
   Main Pipeline
================================ */
async function run() {
  const query =
    "Explain GPT-3 and how few-shot learning works.";

  console.log("\n🔍 Running Hybrid Retrieval...\n");

  const searchResult = await searchQuery(query);
  const indices = searchResult.indices[0].slice(0, 3);
  const distances = searchResult.distances[0];

  const vectorMap = JSON.parse(
    fs.readFileSync(vectorMapPath)
  );

  const hybridContext = [];

  for (const idx of indices) {
    const match = vectorMap.find(
      v => v.faissIndex === idx
    );
    if (!match) continue;

    const paperFile = `${match.paperId}.json`;
    const paper = JSON.parse(
      fs.readFileSync(
        path.join(processedPath, paperFile)
      )
    );

    const chunk = paper.chunks.find(
      c => c.chunkIndex === match.chunkIndex
    );

    if (!chunk) continue;

    const graphRes = await runQuery(
      `
      MATCH (p:ResearchPaper {paperId: $paperId})
      OPTIONAL MATCH (p)-[:WRITTEN_BY]->(a:Author)
      RETURN p.title AS title,
             p.year AS year,
             collect(a.authorName) AS authors
      `,
      { paperId: match.paperId }
    );

    const graphData =
      graphRes.records[0]?.toObject();

    hybridContext.push({
      paperId: match.paperId,
      title: graphData?.title || "Unknown",
      year: graphData?.year || "Unknown",
      authors: graphData?.authors || [],
      section: match.sectionName,
      chunkText: extractKeySentences(
        chunk.chunkText
      )
    });
  }

  /* ================================
     EARLY RELEVANCE CHECK (CRITICAL)
  ================================= */

  const retrievalMetrics = evaluateRetrieval(
    query,
    hybridContext
  );

  console.log("Retrieval Metrics:", retrievalMetrics);

  const retrievalScore = parseFloat(
    retrievalMetrics.precision
  );

  if (retrievalScore === 0) {
    console.log(
      "\n⚠️ Query not related to indexed documents."
    );
    console.log(
      "System Response: I am not confident enough to answer this question."
    );
    return; // 🚨 STOP BEFORE LLM
  }

  console.log("\n🧠 Generating Answer...\n");

  const answer = await generateSummary(
    query,
    hybridContext
  );

  console.log("===== GENERATED ANSWER =====\n");
  console.log(answer);

  console.log("\n📊 Evaluating Faithfulness...\n");

  const faithfulnessMetrics =
    evaluateFaithfulness(
      answer,
      hybridContext
    );

  console.log(
    "Faithfulness Metrics:",
    faithfulnessMetrics
  );

  /* ================================
     Confidence Score
  ================================= */

  const avgDistance =
    distances.reduce((a, b) => a + b, 0) /
    distances.length;

  const vectorConfidence = 1 / (1 + avgDistance);
  const groundednessScore =
    1 -
    parseFloat(
      faithfulnessMetrics.hallucinationRatio
    );

  const finalConfidence = (
    0.5 * retrievalScore +
    0.3 * groundednessScore +
    0.2 * vectorConfidence
  ).toFixed(2);

  console.log("\n📈 Final Confidence Score:", finalConfidence);
  console.log("\n✅ Evaluation Complete\n");
}

run().catch(console.error);