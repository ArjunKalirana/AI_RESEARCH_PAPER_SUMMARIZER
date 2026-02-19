function extractEntities(chunkText) {
    const entities = [];
  
    const text = chunkText.toLowerCase();
  
    if (text.includes("transformer")) {
      entities.push({ type: "Method", name: "Transformer-based model" });
    }
  
    if (text.includes("bert")) {
      entities.push({ type: "Method", name: "BERT" });
    }
  
    if (text.includes("imagenet")) {
      entities.push({ type: "Dataset", name: "ImageNet" });
    }
  
    if (text.includes("cifar")) {
      entities.push({ type: "Dataset", name: "CIFAR-10" });
    }
  
    return entities;
  }
  
  module.exports = { extractEntities };
  