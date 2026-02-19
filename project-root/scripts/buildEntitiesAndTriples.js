const fs = require("fs");
const path = require("path");

const INPUT_DIR = path.join(__dirname, "../data/processed_papers");
const ENTITY_DIR = path.join(__dirname, "../data/derived/entities");
const TRIPLE_DIR = path.join(__dirname, "../data/derived/triples");

fs.mkdirSync(ENTITY_DIR, { recursive: true });
fs.mkdirSync(TRIPLE_DIR, { recursive: true });

function buildEntitiesAndTriples() {
  const files = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith(".json"));

  for (const file of files) {
    console.log(`🧠 Generating entities & triples for ${file}`);

    const paper = JSON.parse(
      fs.readFileSync(path.join(INPUT_DIR, file), "utf-8")
    );

    const entities = [];
    const triples = [];

    const paperEntityId = paper.paperId;

    /* ============================
       ResearchPaper Entity
    ============================ */
    entities.push({
      id: paperEntityId,
      type: "ResearchPaper",
      properties: {
        title: paper.title,
        year: paper.year
      }
    });

    /* ============================
       Source Entity
    ============================ */
    if (paper.source) {
      const sourceId = `source_${paper.source.sourceName}`;

      entities.push({
        id: sourceId,
        type: "Source",
        properties: paper.source
      });

      triples.push({
        subject: paperEntityId,
        predicate: "SOURCED_FROM",
        object: sourceId
      });
    }

    /* ============================
       Author Entities
    ============================ */
    for (const author of paper.authors) {
      const authorId = `author_${author.authorName}`;

      entities.push({
        id: authorId,
        type: "Author",
        properties: author
      });

      triples.push({
        subject: paperEntityId,
        predicate: "WRITTEN_BY",
        object: authorId
      });
    }

    /* ============================
       Section Entities
    ============================ */
    for (const [sectionName, sectionText] of Object.entries(paper.sections)) {
      const sectionId = `section_${sectionName}`;

      entities.push({
        id: sectionId,
        type: "Section",
        properties: {
          sectionName,
          sectionText
        }
      });

      triples.push({
        subject: paperEntityId,
        predicate: "HAS_SECTION",
        object: sectionId
      });
    }

    /* ============================
       Chunk Entities
    ============================ */
    for (const chunk of paper.chunks) {
      const chunkId = `chunk_${chunk.chunkIndex}_${paperEntityId}`;

      entities.push({
        id: chunkId,
        type: "Chunk",
        properties: {
          chunkIndex: chunk.chunkIndex,
          chunkText: chunk.chunkText
        }
      });

      triples.push({
        subject: paperEntityId,
        predicate: "HAS_CHUNK",
        object: chunkId
      });

      if (chunk.sectionName) {
        triples.push({
          subject: chunkId,
          predicate: "REPRESENTS_PART_OF",
          object: `section_${chunk.sectionName}`
        });
      }
    }

    /* ============================
       WRITE FILES
    ============================ */
    fs.writeFileSync(
      path.join(ENTITY_DIR, file.replace(".json", ".entities.json")),
      JSON.stringify(entities, null, 2)
    );

    fs.writeFileSync(
      path.join(TRIPLE_DIR, file.replace(".json", ".triples.json")),
      JSON.stringify(triples, null, 2)
    );

    console.log("✅ Entity & triple JSON generated");
  }
}

buildEntitiesAndTriples();
