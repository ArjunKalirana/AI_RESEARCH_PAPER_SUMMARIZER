const axios = require("axios");
const FAISS_URL = process.env.FAISS_URL || "http://localhost:8001";

async function indexChunks(chunks, index_id) {
  const response = await axios.post(`${FAISS_URL}/index`, {
    index_id: index_id,
    chunks: chunks,
  });
  return response.data;
}

/**
 * searchQuery: tries /search-reranked first for better answer quality.
 * Falls back silently to the original /search if reranking fails.
 */
async function searchQuery(query, index_id, k = 6) {
  try {
    const results = await searchQueryReranked(query, index_id, k);
    console.log("[FAISS] using reranker");
    return results;
  } catch (err) {
    console.log("[FAISS] fallback to basic search —", err.message || err);
    const response = await axios.post(`${FAISS_URL}/search`, {
      index_id: index_id,
      query: query,
      k: k,
    });
    return response.data;
  }
}

/**
 * searchQueryReranked: calls /search-reranked directly.
 */
async function searchQueryReranked(query, index_id, k = 5, fetch_k = 20) {
  const response = await axios.post(`${FAISS_URL}/search-reranked`, {
    index_id: index_id,
    query: query,
    k: k,
    fetch_k: fetch_k,
  });

  if (response.data.error) {
    throw new Error(response.data.error);
  }

  return response.data;
}

async function computeSimilarity(text1, text2) {
  try {
    const response = await axios.post(`${FAISS_URL}/similarity`, {
      text1: text1,
      text2: text2,
    });
    return response.data;
  } catch (error) {
    console.error("Similarity API error:", error);
    return { similarity: 0 };
  }
}

module.exports = { indexChunks, searchQuery, searchQueryReranked, computeSimilarity };
