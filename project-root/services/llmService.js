const { OpenAI } = require("openai");

// --- AI CONFIGURATION (Groq Cloud is our free alternative) ---
const GROQ_URL = "https://api.groq.com/openai/v1";
const AI_MODEL = "llama-3.3-70b-versatile"; // High-quality free model on Groq

const openai = new OpenAI({
    apiKey: process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY,
    baseURL: process.env.AI_BASE_URL || GROQ_URL
});

// ============================================================
// GUARDRAIL 1: Relaxed Grounding
// ============================================================
function isQueryGrounded(query, contextBlocks) {
  if (!contextBlocks || contextBlocks.length === 0) return false;

  const combinedContext = contextBlocks
    .map((c) => c.chunkText.toLowerCase())
    .join(" ");

  // Simple check: does at least one non-trivial word from the query appear in the context?
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (queryWords.length === 0) return true; // Let OpenAI handle very short queries

  const match = queryWords.some(word => combinedContext.includes(word));
  return match;
}

// ============================================================
// REFINED Post-processing
// ============================================================
function extractAnswerFromResponse(rawText) {
  return rawText.trim() || "I am not confident enough to answer this question based on the uploaded paper.";
}

// ============================================================
// MAIN FUNCTIONS
// ============================================================
async function generateSummary(query, contextBlocks, chatHistory = [], onChunk = null) {
  console.log(`🧠 AI processing question: "${query}" with ${contextBlocks.length} context blocks.`);

  if (!isQueryGrounded(query, contextBlocks)) {
    console.log("⚠️ Query not grounded in context. Rejecting.");
    const msg = "I'm sorry, but I couldn't find relevant information in the paper to answer that specific question.";
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
3. Don't mention "the provided context" or "chunks". Just answer.
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
    const stream = await openai.chat.completions.create({
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
    console.error("❌ OpenAI API Error:", error);
    throw error;
  }
}

async function generateStructuredSummary(contextBlocks) {
  console.log("🧠 Generating structured summary...");
  const contextText = contextBlocks
    .map((c, i) => `Source Chunk ${i + 1} (Section: ${c.section})\n${c.chunkText}`)
    .join("\n---\n");

  try {
    const response = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: "You are an expert academic summarizer. Generate a structured, detailed summary based on the provided paper excerpts. Use clear headings and bullet points for readability."
        },
        {
          role: "user",
          content: `Generate a summary with these sections: Problem, Approach, Methodology, and Key Results.\n\nCONTEXT:\n${contextText}`
        }
      ],
      temperature: 0.3,
    });

    const summary = response.choices[0].message.content.trim();
    console.log("✅ Summary generated successfully.");
    return summary;
  } catch (error) {
    console.error("❌ AI Summary Error:", error);
    return "Failed to generate summary. Please check your AI API key or try again.";
  }
}

async function rewriteQuery(query, chatHistory = []) {
  if (chatHistory.length === 0) return query;
  const historyText = chatHistory.slice(-3).map(m => `${m.role}: ${m.content}`).join("\n");

  try {
    const response = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: "Rewrite the user's latest question to be a standalone search query, incorporating context from the recent chat history if necessary. Output ONLY the rewritten query."
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
    console.error("❌ Query Rewrite Error:", error);
    return query;
  }
}

module.exports = { generateSummary, generateStructuredSummary, rewriteQuery };