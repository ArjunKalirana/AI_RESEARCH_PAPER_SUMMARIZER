const fs = require("fs");
const path = require("path");
const { runQuery } = require("../services/neo4j.service");

const DATA_DIR = path.join(__dirname, "../data/processed_papers");

async function buildKnowledgeGraph() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));

  for (const file of files) {
    console.log(`📘 Ingesting into Neo4j: ${file}`);

    const paper = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, file), "utf-8")
    );

    const {
      paperId,
      title,
      year,
      source,
      authors,
      sections,
      chunks
    } = paper;

    /* ============================
       ResearchPaper NODE
    ============================ */
    await runQuery(
      `
      MERGE (p:ResearchPaper {paperId: $paperId})
      SET p.title = $title,
          p.year = $year
      `,
      { paperId, title, year }
    );

    /* ============================
       Source NODE + RELATION
    ============================ */
    if (source) {
      await runQuery(
        `
        MERGE (s:Source {sourceName: $name})
        SET s.sourceURL = $url
        `,
        {
          name: source.sourceName,
          url: source.sourceURL
        }
      );

      await runQuery(
        `
        MATCH (p:ResearchPaper {paperId: $paperId})
        MATCH (s:Source {sourceName: $name})
        MERGE (p)-[:SOURCED_FROM]->(s)
        `,
        { paperId, name: source.sourceName }
      );
    }

    /* ============================
       Author NODES + RELATION
    ============================ */
    for (const author of authors) {
      await runQuery(
        `
        MERGE (a:Author {authorName: $name})
        SET a.affiliation = $affiliation
        `,
        {
          name: author.authorName,
          affiliation: author.affiliation
        }
      );

      await runQuery(
        `
        MATCH (p:ResearchPaper {paperId: $paperId})
        MATCH (a:Author {authorName: $name})
        MERGE (p)-[:WRITTEN_BY]->(a)
        `,
        { paperId, name: author.authorName }
      );
    }

    /* ============================
       Section NODES + RELATION
    ============================ */
    for (const [sectionName, sectionText] of Object.entries(sections)) {
      await runQuery(
        `
        MERGE (s:Section {sectionName: $name})
        SET s.sectionText = $text
        `,
        { name: sectionName, text: sectionText }
      );

      await runQuery(
        `
        MATCH (p:ResearchPaper {paperId: $paperId})
        MATCH (s:Section {sectionName: $name})
        MERGE (p)-[:HAS_SECTION]->(s)
        `,
        { paperId, name: sectionName }
      );
    }

    /* ============================
       Chunk NODES + RELATIONS
    ============================ */
    for (const chunk of chunks) {
      await runQuery(
        `
        MERGE (c:Chunk {paperId: $paperId, chunkIndex: $index})
        SET c.chunkText = $text
        `,
        {
          paperId,
          index: chunk.chunkIndex,
          text: chunk.chunkText
        }
      );

      await runQuery(
        `
        MATCH (p:ResearchPaper {paperId: $paperId})
        MATCH (c:Chunk {paperId: $paperId, chunkIndex: $index})
        MERGE (p)-[:HAS_CHUNK]->(c)
        `,
        { paperId, index: chunk.chunkIndex }
      );

      if (chunk.sectionName) {
        await runQuery(
          `
          MATCH (c:Chunk {paperId: $paperId, chunkIndex: $index})
          MATCH (s:Section {sectionName: $section})
          MERGE (c)-[:REPRESENTS_PART_OF]->(s)
          `,
          {
            paperId,
            index: chunk.chunkIndex,
            section: chunk.sectionName
          }
        );
      }
    }
  }

  console.log("✅ Neo4j graph successfully built from JSON");
}

buildKnowledgeGraph().catch(console.error);
