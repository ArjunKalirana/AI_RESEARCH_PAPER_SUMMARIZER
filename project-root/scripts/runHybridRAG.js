const fs = require("fs");
const path = require("path");
const { searchQuery } = require("../services/faissService");
const { runQuery } = require("../services/neo4j.service");
const { generateSummary } = require("../services/llmService");

const vectorMapPath = path.join(__dirname, "../data/vector_map.json");
const processedPath = path.join(__dirname, "../data/processed_papers");

// 🔹 Extractive Compression Function
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

async function run() {
  const query = "Explain GPT-3 and how few-shot learning works.";

  // 1️⃣ Vector Search
  const searchResult = await searchQuery(query);
  const indices = searchResult.indices[0].slice(0, 3);

  const vectorMap = JSON.parse(fs.readFileSync(vectorMapPath));

  const hybridContext = [];

  for (const idx of indices) {
    const match = vectorMap.find(v => v.faissIndex === idx);
    if (!match) continue;

    const paperFile = `${match.paperId}.json`;
    const paper = JSON.parse(
      fs.readFileSync(path.join(processedPath, paperFile))
    );

    const chunk = paper.chunks.find(
      c => c.chunkIndex === match.chunkIndex
    );

    if (!chunk) continue;

    // 2️⃣ Graph enrichment
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

    const graphData = graphRes.records[0]?.toObject();

    // 3️⃣ Extractive compression
    const compressedText = extractKeySentences(chunk.chunkText);

    hybridContext.push({
      paperId: match.paperId,
      title: graphData?.title || "Unknown",
      year: graphData?.year || "Unknown",
      authors: graphData?.authors || [],
      section: match.sectionName,
      chunkText: compressedText
    });
  }

  console.log("\nGenerating Summary...\n");

  const summary = await generateSummary(query, hybridContext);

  console.log("\n===== FINAL SUMMARY =====\n");
  console.log(summary);
}

run().catch(console.error);