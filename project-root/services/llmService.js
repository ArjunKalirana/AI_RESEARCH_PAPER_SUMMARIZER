const axios = require("axios");

// ============================================================
// GUARDRAIL 1: Off-topic detection (runs BEFORE LLM)
// Requires at least 2 meaningful keyword matches in retrieved context.
// A single-word overlap was too permissive — borderline queries slipped through.
// ============================================================
function isQueryGrounded(query, contextBlocks) {
  if (!contextBlocks || contextBlocks.length === 0) return false;

  const combinedContext = contextBlocks
    .map((c) => c.chunkText.toLowerCase())
    .join(" ");

  const stopWords = new Set([
    "what", "how", "why", "the", "is", "are", "a", "an",
    "of", "in", "to", "does", "did", "was", "were", "it",
    "this", "that", "tell", "me", "about", "paper", "study",
    "research", "explain", "describe", "summarize", "define",
    "which", "with", "for", "on", "at", "who", "their"
  ]);

  // Extract meaningful query keywords (length > 3, not a stopword)
  const queryWords = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));

  // Very generic query — pass through, LLM will self-reject
  if (queryWords.length === 0) return true;

  // Build a word-level set from context for exact matching
  const contextWordSet = new Set(combinedContext.split(/\s+/));

  // Require at least 2 keyword matches for the query to be grounded
  const matches = queryWords.filter((w) => contextWordSet.has(w));
  return matches.length >= 2;
}

// ============================================================
// GUARDRAIL 2: Post-processing (runs AFTER LLM)
// tinyllama ignores format rules, so we extract a clean answer
// from whatever it generates, or fall back to "Not found."
// ============================================================
function extractAnswerFromResponse(rawText, contextBlocks) {
  // Remove echoed prompt sections if tinyllama parroted them back
  let cleaned = rawText
    .replace(/###[\s\S]*?Answer.*?:/i, "")
    .replace(/Context:[\s\S]*?---/i, "")
    .replace(/Based on (the |this )?(context|provided context|above context|paper context)[^.!?]*[.!?]/gi, "")
    .replace(/According to (the |this )?(context|provided context)[^.!?]*[.!?]/gi, "")
    .trim();

  // Grab first clean sentence(s) — tinyllama usually answers first before going off-track
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned];
  let answer = sentences.slice(0, 3).join(" ").trim(); // max 3 sentences

  // ============================================================
  // GUARDRAIL 3: Hallucination detector
  // Checks if the answer words actually appear in the context.
  // If less than 35% match → discard as hallucination.
  // ============================================================
  if (answer && answer.length > 10) {
    const combinedContext = contextBlocks.map((c) => c.chunkText.toLowerCase()).join(" ");

    const answerWords = answer
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(" ")
      .filter((w) => w.length > 4);

    const groundedCount = answerWords.filter((w) => combinedContext.includes(w)).length;
    const ratio = answerWords.length > 0 ? groundedCount / answerWords.length : 0;

    if (ratio < 0.35) {
      return "I am not confident enough to answer this question based on the uploaded paper.";
    }
  }

  // Deduplicate repeated sentences (tinyllama repeats itself)
  if (answer) {
    const allSentences = answer.match(/[^.!?]+[.!?]+/g) || [answer];
    const seen = new Set();
    answer = allSentences
      .filter((s) => {
        const key = s.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join(" ")
      .trim();
  }

  // Strip vague TinyLlama filler openers
  if (answer) {
    const vagueOpeners = [
      /^(the (paper|study|system|authors?|research) (shows?|states?|describes?|presents?|proposes?|finds?|suggests?))[,.]?\s*/i,
      /^(it (is|was|can be) (noted|seen|observed|shown) that)\s*/i,
      /^(in (this|the) (paper|study|research|work))[,.]?\s*/i,
      /^(the (proposed|presented|described) (system|approach|method|pipeline))\s*/i,
      /^(overall[,.]?\s*)/i,
      /^(to summarize[,.]?\s*)/i,
    ];
    vagueOpeners.forEach((pattern) => {
      answer = answer.replace(pattern, "");
    });
    answer = answer.charAt(0).toUpperCase() + answer.slice(1);
    answer = answer.trim();
  }

  return answer || "I am not confident enough to answer this question based on the uploaded paper.";
}

// (Evidence extraction removed — no longer needed)

// ============================================================
// GUARDRAIL 4: Streaming repetition loop killer
// ============================================================
function createRepetitionDetector(threshold = 5) {
  const recentTokens = [];
  return function check(token) {
    recentTokens.push(token.trim());
    if (recentTokens.length > threshold) recentTokens.shift();
    if (
      recentTokens.length === threshold &&
      recentTokens.every((t) => t === recentTokens[0] && t.length > 0)
    ) {
      return true;
    }
    return false;
  };
}

// ============================================================
// MAIN FUNCTION
// ============================================================
const { OpenAI } = require("openai");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ============================================================
// MAIN FUNCTION
// ============================================================
async function generateSummary(query, contextBlocks, chatHistory = [], onChunk = null) {

  // --- GUARDRAIL 1: Reject off-topic before calling LLM ---
  if (!isQueryGrounded(query, contextBlocks)) {
    const msg = "I am not confident enough to answer this question based on the uploaded paper.";
    if (onChunk) onChunk(msg);
    return msg;
  }

  // Chunks processing
  const topChunks = contextBlocks.slice(0, 6);
  const contextText = topChunks
    .map((c, i) => `[${i + 1}] ${c.chunkText.slice(0, 800).trim()}`)
    .join("\n---\n");

  const messages = [
    {
      role: "system",
      content: `You are a research paper Q&A assistant. Your only job is to answer questions using the context chunks provided.
      
Strict rules:
- Answer in 2-4 sentences maximum.
- Use specific details: numbers, names, percentages, component names.
- Never use phrases like "based on", "according to", "the context says".
- Never repeat the same sentence twice.
- If the answer is not in the context, output exactly: "This information is not covered in the paper."`
    }
  ];

  // Add History
  chatHistory.slice(-4).forEach(m => {
      messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
  });

  // Add current query with context
  messages.push({
    role: "user",
    content: `CONTEXT:\n${contextText}\n\nQUESTION: ${query}`
  });

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // Or gpt-4o-mini
      messages: messages,
      temperature: 0.1,
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

    return extractAnswerFromResponse(fullText, contextBlocks);

  } catch (error) {
    console.error("OpenAI Error:", error.message);
    throw new Error("Failed to reach OpenAI. Check your API key.");
  }
}

async function generateStructuredSummary(contextBlocks) {
  const contextText = contextBlocks
    .map((c, i) => `Source ${i + 1}\nTitle: ${c.title}\nSection: ${c.section}\nContent: ${c.chunkText}`)
    .join("\n---\n");

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are an expert academic AI. Read the provided source paper chunks and generate a concise, structured academic summary. DO NOT use conversational filler. FOCUS entirely on facts, numbers, methodology, and results."
        },
        {
          role: "user",
          content: `Generate a structured summary in Markdown format with these headers: ### Problem, ### Proposed Approach, ### Methodology, ### Key Results, ### Contribution.\n\nSOURCE PAPER CHUNKS:\n${contextText}`
        }
      ],
      temperature: 0.2,
    });

    return response.choices[0].message.content.trim();

  } catch (error) {
    console.error("OpenAI Error generating structured summary:", error.message);
    return "Error generating structured summary.";
  }
}

async function rewriteQuery(query, chatHistory = []) {
  if (!chatHistory || chatHistory.length === 0) {
    return query;
  }

  const formattedHistory = chatHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n");

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are an expert search query generator. Rewrite the User's Follow-up Question into a single standalone search query. Replace pronouns with entities from history. Output ONLY the rewritten string."
        },
        {
          role: "user",
          content: `HISTORY:\n${formattedHistory}\n\nUSER QUESTION: ${query}\n\nREWRITTEN QUERY:`
        }
      ],
      temperature: 0.1,
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("OpenAI Error rewriting query:", error.message);
    return query;
  }
}

module.exports = { generateSummary, generateStructuredSummary, rewriteQuery };