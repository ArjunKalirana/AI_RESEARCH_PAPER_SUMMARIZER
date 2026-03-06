const axios = require("axios");

const FAISS_URL = "http://localhost:8001";

async function addTexts(texts, index_id) {
  const response = await axios.post(`${FAISS_URL}/add`, {
    index_id: index_id,
    texts: texts,
  });
  return response.data;
}

async function searchQuery(query, index_id, k=6) {
  const response = await axios.post(`${FAISS_URL}/search`, {
    index_id: index_id,
    query: query,
    k: k
  });
  return response.data;
}

async function computeSimilarity(text1, text2) {
  try {
    const response = await axios.post(`${FAISS_URL}/similarity`, {
      text1: text1,
      text2: text2
    });
    return response.data;
  } catch (error) {
    console.error("Similarity API error:", error);
    return { similarity: 0 };
  }
}

module.exports = { addTexts, searchQuery, computeSimilarity };
