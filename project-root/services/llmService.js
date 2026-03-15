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
async function generateSummary(query, contextBlocks, chatHistory = [], onChunk = null) {

  // --- GUARDRAIL 1: Reject off-topic before calling LLM ---
  if (!isQueryGrounded(query, contextBlocks)) {
    const msg = "I am not confident enough to answer this question based on the uploaded paper.";
    if (onChunk) onChunk(msg);
    return msg;
  }

  // Send up to 6 chunks at 600 chars each — richer context within TinyLlama's token budget
  const topChunks = contextBlocks.slice(0, 6);
  const contextText = topChunks
    .map((c, i) => `[${i + 1}] ${c.chunkText.slice(0, 600).trim()}`)
    .join("\n---\n");

  // Only last 2 history turns to balance token budget with larger context
  const formattedHistory =
    chatHistory.length > 0
      ? chatHistory
          .slice(-2)
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n")
      : "";

  // Rigid prompt optimised for TinyLlama 1.1B — "specific" keyword forces concrete answers
  const prompt = `### System:
You are a research paper Q&A assistant. Your only job is to answer questions using the context chunks provided below.

Strict rules:
- Answer in 2-4 sentences maximum.
- Use specific details: numbers, names, percentages, component names.
- Never use phrases like "based on", "according to", "the context says".
- Never repeat the same sentence twice.
- Never add commentary about what you are doing.
- If the answer is not in the context, output exactly this and nothing else:
  This information is not covered in the paper.

### Context:
${contextText}
${formattedHistory ? `### Conversation History:\n${formattedHistory}\n` : ""}
### Question:
${query}

### Answer (specific, direct, no repetition):`;

  try {
    const response = await axios.post(
      "http://localhost:11434/api/generate",
      {
        model: "tinyllama",
        prompt: prompt,
        stream: true,
        options: {
          temperature: 0.1,      // as deterministic as possible
          top_p: 0.75,
          num_predict: 150,      // hard cap — short leash prevents runaway
          repeat_penalty: 1.2,  // KEY FIX: breaks repetition probability loops
          repeat_last_n: 64,
          stop: ["###", "Question:", "Context:", "\n\n\n"]
        }
      },
      { responseType: "stream" }
    );

    let rawResponse = "";
    const detectRepetition = createRepetitionDetector(5);

    return new Promise((resolve, reject) => {
      response.data.on("data", (chunk) => {
        try {
          const lines = chunk.toString().split("\n").filter(Boolean);
          for (const line of lines) {
            const parsed = JSON.parse(line);
            const token = parsed.response || "";

            // Kill stream early if repetition loop detected
            if (detectRepetition(token)) {
              response.data.destroy();
              const cleanAnswer = extractAnswerFromResponse(rawResponse, contextBlocks);
              if (onChunk) {
                const words = cleanAnswer.split(" ");
                for (const w of words) onChunk(w + " ");
              }
              resolve(cleanAnswer);
              return;
            }

            rawResponse += token;

            if (parsed.done) {
              const cleanAnswer = extractAnswerFromResponse(rawResponse, contextBlocks);
              if (onChunk) {
                const words = cleanAnswer.split(" ");
                for (const w of words) onChunk(w + " ");
              }
              resolve(cleanAnswer);
            }
          }
        } catch (e) {
          /* skip malformed stream lines */
        }
      });

      response.data.on("error", reject);
    });
  } catch (error) {
    console.error("LLM Error:", error.message);
    throw new Error("Failed to reach Ollama. Is it running?");
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

async function rewriteQuery(query, chatHistory = []) {
  if (!chatHistory || chatHistory.length === 0) {
    return query; // No need to rewrite if no history
  }

  const formattedHistory = chatHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n");

  const prompt = `### System:
You are an expert search query generator. Based on the Chat History, rewrite the User's Follow-up Question into a single, standalone search query that contains all necessary context. Do NOT answer the question. Just output the refined search query.

Rules:
1. Replace pronouns (it, they, them, this, that strategy, etc.) with the exact entities from the History.
2. Keep it concise, keyword-rich, and optimized for vector search.
3. Output ONLY the rewritten string, nothing else.

### Chat History:
${formattedHistory}

### User Follow-up Question:
${query}

### Standalone Search Query:`;

  try {
    const response = await axios.post(
      "http://localhost:11434/api/generate",
      {
        model: "tinyllama",
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 100 
        }
      }
    );

    const rewritten = response.data.response.trim();
    console.log(`[RAG Query Rewriter] Original: "${query}" -> Rewritten: "${rewritten}"`);
    return rewritten;
  } catch (error) {
    console.error("LLM Error rewriting query:", error.message);
    return query; // Fallback to original
  }
}

module.exports = { generateSummary, generateStructuredSummary, rewriteQuery };