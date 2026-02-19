function extractRelationships(paperId, entities) {
    const relations = [];
  
    entities.forEach(entity => {
      if (entity.type === "Method") {
        relations.push({
          subject: paperId,
          predicate: "PROPOSES",
          object: entity.name,
          objectType: "Method"
        });
      }
  
      if (entity.type === "Dataset") {
        relations.push({
          subject: paperId,
          predicate: "USES_DATASET",
          object: entity.name,
          objectType: "Dataset"
        });
      }
    });
  
    return relations;
  }
  
  module.exports = { extractRelationships };
  