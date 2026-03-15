const fs = require("fs");
const path = require("path");
const { indexChunks } = require("../services/faissService");

const processedPath = path.join(__dirname, "../data/processed_papers");
const vectorMapPath = path.join(__dirname, "../data/vector_map.json");

async function run() {
  const files = fs.readdirSync(processedPath);

  for (const file of files) {
    const paper = JSON.parse(
      fs.readFileSync(path.join(processedPath, file))
    );

    const paperId = paper.paperId;
    console.log(`Embedding ${paper.chunks.length} chunks for:`, paperId);
    
    try {
      await indexChunks(paper.chunks, paperId);
      console.log(`Successfully embedded all chunks for ${paperId}.`);
    } catch (err) {
      console.error(`Failed to embed chunks for ${paperId}:`, err.message);
    }
  }

  console.log("All chunks embedded successfully.");
}

run();
