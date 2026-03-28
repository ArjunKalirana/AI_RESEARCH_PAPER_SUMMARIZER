const axios = require("axios");
const FAISS_URL = process.env.FAISS_URL || "http://localhost:8001";

console.log(`🔌 [FAISS] Service URL: ${FAISS_URL}`);

async function indexChunks(chunks, index_id) {
  console.log(`[FAISS] Requesting /index for index_id: ${index_id}`);
  try {
    const response = await axios.post(`${FAISS_URL}/index`, {
      index_id: index_id,
      chunks: chunks,
    });
    console.log(`[FAISS] /index SUCCESS`);
    return response.data;
  } catch (err) {
    console.error(`[FAISS] /index ERROR: ${err.message}`);
    throw err;
  }
}

/**
 * searchQuery: tries /search-reranked first for better answer quality.
 * Falls back silently to the original /search if reranking fails.
 */
async function searchQuery(query, index_id, k = 6) {
  try {
    const results = await searchQueryReranked(query, index_id, k);
    console.log("[FAISS] using reranker SUCCESS");
    return results;
  } catch (err) {
    console.log(`[FAISS] fallback to basic search — ${err.message}`);
    console.log(`[FAISS] Requesting /search for index_id: ${index_id}`);
    const response = await axios.post(`${FAISS_URL}/search`, {
      index_id: index_id,
      query: query,
      k: k,
    });
    console.log(`[FAISS] /search SUCCESS`);
    return response.data;
  }
}

/**
 * searchQueryReranked: calls /search-reranked directly.
 */
async function searchQueryReranked(query, index_id, k = 5, fetch_k = 20) {
  console.log(`[FAISS] Requesting /search-reranked for index_id: ${index_id}`);
  const response = await axios.post(`${FAISS_URL}/search-reranked`, {
    index_id: index_id,
    query: query,
    k: k,
    fetch_k: fetch_k,
  });

  if (response.data.error) {
    console.error(`[FAISS] /search-reranked returned error: ${response.data.error}`);
    throw new Error(response.data.error);
  }

  return response.data;
}

async function computeSimilarity(text1, text2) {
  try {
    console.log(`[FAISS] Requesting /similarity`);
    const response = await axios.post(`${FAISS_URL}/similarity`, {
      text1: text1,
      text2: text2,
    });
    return response.data;
  } catch (error) {
    console.error("[FAISS] Similarity API error:", error.message);
    return { similarity: 0 };
  }
}

module.exports = { indexChunks, searchQuery, searchQueryReranked, computeSimilarity };
