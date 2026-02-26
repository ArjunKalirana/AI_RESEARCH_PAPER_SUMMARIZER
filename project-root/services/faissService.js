const axios = require("axios");

const FAISS_URL = "http://localhost:8001";

async function addTexts(texts) {
  const response = await axios.post(`${FAISS_URL}/add`, {
    texts: texts,
  });
  return response.data;
}

async function searchQuery(query) {
  const response = await axios.post(`${FAISS_URL}/search`, {
    query: query,
  });
  return response.data;
}

module.exports = { addTexts, searchQuery };
