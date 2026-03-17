const Groq = require("groq-sdk");

// --- PURE GROQ CONFIGURATION ---
const AI_MODEL = "llama-3.3-70b-versatile"; 

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

// ============================================================
// GUARDRAIL 1: Relaxed Grounding
// ============================================================
function isQueryGrounded(query, contextBlocks) {
  if (!contextBlocks || contextBlocks.length === 0) return false;

  const combinedContext = contextBlocks
    .map((c) => c.chunkText.toLowerCase())
    .join(" ");

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (queryWords.length === 0) return true; 

  const match = queryWords.some(word => combinedContext.includes(word));
  return match;
}

// ============================================================
// REFINED Post-processing
// ============================================================
function extractAnswerFromResponse(rawText) {
  return rawText.trim() || "I'm sorry, I couldn't find a confident answer in the paper.";
}

// ============================================================
// MAIN FUNCTIONS
// ============================================================
async function generateSummary(query, contextBlocks, chatHistory = [], onChunk = null) {
  console.log(`🧠 [Groq] Processing question: "${query}"`);

  if (!isQueryGrounded(query, contextBlocks)) {
    console.log("⚠️ Query not grounded. Rejecting.");
    const msg = "I'm sorry, but I couldn't find relevant information in the paper to answer that.";
    if (onChunk) onChunk(msg);
    return msg;
  }

  const contextText = contextBlocks
    .map((c, i) => `[Block ${i + 1}] (Section: ${c.section || 'Unknown'})\n${c.chunkText}`)
    .join("\n---\n");

  const messages = [
    {
      role: "system",
      content: `You are a Research Assistant. Use the provided context to answer the user's question accurately.
RULES:
1. Be professional, academic, and detailed.
2. If the answer is not in the context, say so politely.
3. Don't mention "the provided context". Just answer.
4. Keep it concise but ensure all key facts are included.`
    }
  ];

  chatHistory.slice(-6).forEach(m => {
      messages.push({ role: m.role || 'user', content: m.content });
  });

  messages.push({
    role: "user",
    content: `CONTEXT FROM PAPER:\n${contextText}\n\nUSER QUESTION: ${query}`
  });

  try {
    const stream = await groq.chat.completions.create({
      model: AI_MODEL,
      messages: messages,
      temperature: 0.2,
      stream: true,
    });

    let fullText = "";
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) {
        fullText += content;
        if (onChunk) onChunk(content);
      }
    }
    return extractAnswerFromResponse(fullText);
  } catch (error) {
    console.error("❌ Groq API Error:", error.message);
    if (error.status === 401) {
        return "ERROR: Invalid Groq API Key. Please check your docker-compose.yml settings.";
    }
    return "Failed to connect to the AI service. Please try again.";
  }
}

async function generateStructuredSummary(contextBlocks) {
  console.log("🧠 [Groq] Generating structured summary...");
  const contextText = contextBlocks
    .map((c, i) => `Chunk ${i + 1} (Section: ${c.section})\n${c.chunkText}`)
    .join("\n---\n");

  try {
    const response = await groq.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: "You are an expert academic summarizer. Generate a structured summary with headings: Problem, Approach, Methodology, and Key Results."
        },
        {
          role: "user",
          content: `CONTEXT:\n${contextText}`
        }
      ],
      temperature: 0.3,
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("❌ Groq Summary Error:", error.message);
    return "Failed to generate summary due to an API error.";
  }
}

async function rewriteQuery(query, chatHistory = []) {
  if (chatHistory.length === 0) return query;
  const historyText = chatHistory.slice(-3).map(m => `${m.role}: ${m.content}`).join("\n");

  try {
    const response = await groq.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: "Rewrite the user's latest question to be a standalone search query. Output ONLY the rewritten query."
        },
        {
          role: "user",
          content: `HISTORY:\n${historyText}\n\nLATEST QUESTION: ${query}`
        }
      ],
      temperature: 0,
    });
    return response.choices[0].message.content.trim();
  } catch (error) {
    return query;
  }
}

module.exports = { generateSummary, generateStructuredSummary, rewriteQuery };