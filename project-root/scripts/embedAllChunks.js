const fs = require("fs");
const path = require("path");
const { addTexts } = require("../services/faissService");

const processedPath = path.join(__dirname, "../data/processed_papers");
const vectorMapPath = path.join(__dirname, "../data/vector_map.json");

async function run() {
  const files = fs.readdirSync(processedPath);
  let vectorMap = [];

  if (fs.existsSync(vectorMapPath)) {
    vectorMap = JSON.parse(fs.readFileSync(vectorMapPath));
  }

  for (const file of files) {
    const paper = JSON.parse(
      fs.readFileSync(path.join(processedPath, file))
    );

    const paperId = paper.paperId;

    for (const chunk of paper.chunks) {
      const chunkIdentifier = `${paperId}_${chunk.chunkIndex}`;

      console.log("Embedding:", chunkIdentifier);
      const response = await addTexts([chunk.chunkText]);


      const faissIndex = response.start_index;

      vectorMap.push({
        faissIndex: faissIndex,
        paperId: paperId,
        chunkIndex: chunk.chunkIndex,
        sectionName: chunk.sectionName
      });

      fs.writeFileSync(
        vectorMapPath,
        JSON.stringify(vectorMap, null, 2)
      );
    }
  }

  console.log("All chunks embedded successfully.");
}

run();
