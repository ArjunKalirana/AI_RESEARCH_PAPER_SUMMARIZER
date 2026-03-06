const axios = require("axios");

async function generateSummary(query, contextBlocks, chatHistory = []) {
  // 🔹 Build compressed structured context
  const contextText = contextBlocks
    .map((c, i) => `Source ${i + 1}\nTitle: ${c.title}\nSection: ${c.section}\nContent: ${c.chunkText}`)
    .join("\n---\n");

  const formattedHistory = chatHistory.length > 0 
    ? chatHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n") 
    : "No previous history.";

  // 🔹 Strict grounding prompt with memory
  const prompt = `You are an academic research assistant.

Answer the question directly using ONLY the retrieved context.

Rules:
- Do NOT restate the question.
- Extract exact numerical values when present.
- Be concise (max 6 sentences).
- If the answer is not explicitly stated, respond exactly:
Not found in the paper.
- Do not refer to context or chat history.

Chat History:
${formattedHistory}

Source Context:
${contextText}

Question:
${query}

Answer:`;

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

async function generateStructuredSummary(contextBlocks) {
  const contextText = contextBlocks
    .map((c, i) => `Source ${i + 1}\nTitle: ${c.title}\nSection: ${c.section}\nContent: ${c.chunkText}`)
    .join("\n---\n");

  const prompt = `
You are an expert academic AI. Read the provided source paper chunks and generate a concise, structured academic summary.

### RULES:
- DO NOT use conversational filler (e.g., "Here is the summary", "Based on the text").
- DO NOT mention the "provided context", "chunks", or the AI itself.
- FOCUS entirely on facts, numbers, methodology, and results.
- Your output MUST follow this exact Markdown format:

### Problem
[Describe the core problem or gap in 2-3 sentences]

### Proposed Approach
[How does the paper solve the problem?]

### Methodology
[What data, experiments, or architectures were used?]

### Key Results
[List numerical findings and primary outcomes]

### Contribution
[What is the main takeaway or impact of this paper?]

---

### Source Paper Chunks:
${contextText}

### Academic Summary:
`;

  try {
    const response = await axios.post(
      "http://localhost:11434/api/generate",
      {
        model: "tinyllama",
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.2,
          top_p: 0.8,
          num_predict: 800 // Extended for longer structured output
        }
      }
    );

    return response.data.response.trim();

  } catch (error) {
    console.error("LLM Error generating structured summary:", error.message);
    return "Error generating structured summary.";
  }
}

module.exports = { generateSummary, generateStructuredSummary };