const fs = require("fs");
const path = require("path");
const { searchQuery } = require("../services/faissService");

const vectorMapPath = path.join(__dirname, "../data/vector_map.json");
const processedPath = path.join(__dirname, "../data/processed_papers");

async function run() {
  const query = "What is GPT-3 and how does few-shot learning work?";

  const searchResult = await searchQuery(query);

  const indices = searchResult.indices[0];

  const vectorMap = JSON.parse(fs.readFileSync(vectorMapPath));

  console.log("\nTop Matching Chunks:\n");

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

    console.log("Paper:", match.paperId);
    console.log("Section:", match.sectionName);
    console.log("Chunk Index:", match.chunkIndex);
    console.log("Text Preview:", chunk.chunkText.slice(0, 200));
    console.log("--------------------------------------------------\n");
  }
}

run();