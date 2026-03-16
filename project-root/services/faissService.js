const axios = require("axios");

const FAISS_URL = process.env.FAISS_URL || "http://localhost:8001";
async function indexChunks(chunks, index_id) {
  const response = await axios.post(`${FAISS_URL}/index`, {
    index_id: index_id,
    chunks: chunks,
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

module.exports = { indexChunks, searchQuery, computeSimilarity };
