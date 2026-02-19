function buildTriples(paper, chunk, entities, relationships) {
    const triples = [];
  
    // Paper → Chunk
    triples.push({
      subject: paper.paperId,
      predicate: "HAS_CHUNK",
      object: `Chunk_${chunk.chunkIndex}`
    });
  
    // Chunk → Section
    if (chunk.sectionName) {
      triples.push({
        subject: `Chunk_${chunk.chunkIndex}`,
        predicate: "REPRESENTS_PART_OF",
        object: chunk.sectionName
      });
    }
  
    // Entity relationships
    relationships.forEach(rel => {
      triples.push({
        subject: rel.subject,
        predicate: rel.predicate,
        object: rel.object
      });
    });
  
    return triples;
  }
  
  module.exports = { buildTriples };
  