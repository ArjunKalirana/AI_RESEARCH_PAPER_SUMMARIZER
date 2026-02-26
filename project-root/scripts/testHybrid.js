const fs = require("fs");
const path = require("path");
const { searchQuery } = require("../services/faissService");
const { runQuery } = require("../services/neo4j.service");

const vectorMapPath = path.join(__dirname, "../data/vector_map.json");
const processedPath = path.join(__dirname, "../data/processed_papers");

async function run() {
  const query = "What is GPT-3 and how does few-shot learning work?";

  // 1️⃣ Vector Search
  const searchResult = await searchQuery(query);
  const indices = searchResult.indices[0];

  const vectorMap = JSON.parse(fs.readFileSync(vectorMapPath));

  const hybridContext = [];

  for (const idx of indices) {
    const match = vectorMap.find(v => v.faissIndex === idx);
    if (!match) continue;

    // 2️⃣ Get chunk text
    const paperFile = `${match.paperId}.json`;
    const paper = JSON.parse(
      fs.readFileSync(path.join(processedPath, paperFile))
    );

    const chunk = paper.chunks.find(
      c => c.chunkIndex === match.chunkIndex
    );

    // 3️⃣ Graph Query for structured info
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

    const graphData = graphRes.records[0].toObject();

    hybridContext.push({
      paperId: match.paperId,
      title: graphData.title,
      year: graphData.year,
      authors: graphData.authors,
      section: match.sectionName,
      chunkText: chunk.chunkText
    });
  }

  console.log("\n--- HYBRID CONTEXT ---\n");
  console.dir(hybridContext, { depth: null });
}

run().catch(console.error);