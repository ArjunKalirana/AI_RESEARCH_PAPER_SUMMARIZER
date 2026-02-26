const axios = require("axios");

async function generateSummary(query, contextBlocks) {
  // 🔹 Build compressed structured context
  const contextText = contextBlocks
    .map((c, i) => `
Source ${i + 1}
Title: ${c.title}
Year: ${c.year}
Section: ${c.section}

Content:
${c.chunkText}
`)
    .join("\n-----------------------------\n");

  // 🔹 Strict grounding prompt
  
  const prompt = `
Answer the question using ONLY the context below.

Do NOT repeat the question.
Do NOT describe the task.
Do NOT mention instructions.
Write the answer directly.

Question:
${query}

Context:
${contextText}

Answer:
`;

  try {
    const response = await axios.post(
      "http://localhost:11434/api/generate",
      {
        model: "tinyllama",
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.2,   // 🔹 reduces hallucination
          top_p: 0.8,
          num_predict: 400    // 🔹 limit output length
        }
      }
    );

    return response.data.response.trim();

  } catch (error) {
    console.error("LLM Error:", error.message);
    return "Error generating summary.";
  }
}

module.exports = { generateSummary };