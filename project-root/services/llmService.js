const Groq = require("groq-sdk");

// --- MODEL TIERING ---
// Llama 4 Scout: 500K TPD vs 70B's 100K TPD — 5x more daily capacity, prevents 429 crashes
const CHAT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const SUMMARY_MODEL = "llama-3.1-8b-instant";      // For high-volume tasks (Higher rate limits)

if (!process.env.GROQ_API_KEY) {
    console.error('❌ FATAL: GROQ_API_KEY environment variable is not set. Exiting.');
    process.exit(1);
}

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

// Timeout-protected stream reader — prevents hanging when Groq opens connection but sends no data
async function readStreamWithTimeout(streamPromise, onChunk, idleTimeoutMs = 30000) {
  console.log(`  ⏳ [LLM] Waiting for Groq stream connection (timeout: ${idleTimeoutMs/1000}s)...`);
  
  let stream;
  try {
    stream = await Promise.race([
      streamPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Groq connection timed out')), idleTimeoutMs)
      )
    ]);
    console.log('  ✅ [LLM] Stream connection established');
  } catch (connErr) {
    console.error('  ❌ [LLM] Stream connection FAILED:', connErr.message);
    throw connErr;
  }

  let fullText = "";
  let chunkCount = 0;
  const reader = stream[Symbol.asyncIterator]();
  
  while (true) {
    const result = await Promise.race([
      reader.next(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Groq stream idle — no data for 30s')), idleTimeoutMs)
      )
    ]);

    if (result.done) break;

    const content = result.value.choices[0]?.delta?.content || "";
    if (content) {
      chunkCount++;
      fullText += content;
      if (onChunk) onChunk(content);
    }
  }

  console.log(`  ✅ [LLM] Stream complete: ${chunkCount} chunks, ${fullText.length} chars`);
  return fullText;
}

// ============================================================
// EXPONENTIAL BACKOFF RETRY UTILITY
// ============================================================
async function withRetry(fn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 429 && attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        console.log(`⏳ [Groq] Rate limited. Waiting ${Math.round(delay)}ms before retry ${attempt + 1}/${maxRetries - 1}...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// ============================================================
// GUARDRAIL 1: Relaxed Grounding
// ============================================================
function isQueryGrounded(query, contextBlocks) {
  // If FAISS returned chunks, the query is grounded — FAISS already did semantic matching.
  // Only reject if there are literally zero context blocks.
  if (!contextBlocks || contextBlocks.length === 0) return false;
  return true;
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
  console.log(`🧠 [Groq] Processing question: "${query}" | Model: ${CHAT_MODEL} | Context blocks: ${contextBlocks.length}`);

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
    const fullText = await readStreamWithTimeout(
      groq.chat.completions.create({
        model: CHAT_MODEL,
        messages: messages,
        temperature: 0.2,
        stream: true,
      }),
      onChunk
    );
    return extractAnswerFromResponse(fullText);
  } catch (error) {
    console.error("❌ Groq API Error:", error.message);
    if (error.status === 429) {
        console.log("🔄 429 Detected: Falling back to 8B model for chat...");
        // Notify user before generating fallback response
        if (onChunk) onChunk('\n\n[⚡ Switched to fast model due to rate limits — response may be briefer]\n\n');
         try {
          const fallbackText = await readStreamWithTimeout(
            groq.chat.completions.create({
                model: SUMMARY_MODEL,
                messages: messages,
                temperature: 0.2,
                stream: true,
            }),
            onChunk
          );
          return extractAnswerFromResponse(fallbackText);
        } catch (fallbackErr) {
          console.error('❌ Fallback model also failed:', fallbackErr.message);
        }
    }
    // CRITICAL: Stream error to user so they don't see "Thinking..." forever
    const errorMsg = `⚠️ AI service error: ${error.message}. Please try again in a moment.`;
    if (onChunk) onChunk(errorMsg);
    return errorMsg;
  }
}

async function generateStructuredSummary(contextBlocks) {
  console.log("🧠 [Groq] Generating structured summary...");
  const contextText = contextBlocks
    .map((c, i) => `Chunk ${i + 1} (Section: ${c.section})\n${c.chunkText}`)
    .join("\n---\n")
    .slice(0, 12000); // 🚨 TPM GUARD: Limit total tokens to ~3k for summary

  try {
    const response = await groq.chat.completions.create({
      model: SUMMARY_MODEL,
      messages: [
        {
          role: "system",
          content: `You are an expert academic summarizer. Analyze the provided research paper context and generate a structured summary using EXACTLY these markdown headers in order:

## Problem
What specific problem or gap does this paper address? (2-3 sentences)

## Approach  
What is the core proposed solution or methodology? (2-3 sentences)

## Methodology
How was the research conducted? What datasets, models, or experimental setup? (3-4 sentences)

## Key Results
What were the main quantitative or qualitative findings? Include specific numbers if available. (3-4 sentences)

Be precise and academic. Use the paper's own terminology. Do not invent information not present in the context.`
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
    
    // One retry only — if it fails again, return a truncated fallback
    try {
      console.log("🔄 TPM Limit hit. Retrying with truncated context...");
      const truncated = contextBlocks.map(c => ({...c, chunkText: c.chunkText.slice(0, 1000)}));
      const retryResp = await groq.chat.completions.create({
        model: SUMMARY_MODEL,
        messages: [
          { role: "system", content: "Summarize this research paper context briefly in 3-4 sentences covering the main problem, approach, and result." },
          { role: "user", content: truncated.map(c => c.chunkText).join('\n') }
        ],
        temperature: 0.3,
      });
      return retryResp.choices[0].message.content.trim();
    } catch (retryErr) {
      console.error("❌ Critical Summary Failure:", retryErr.message);
      return "Summary temporarily unavailable — please try clicking 'Ask AI' for an interactive analysis.";
    }
    
    return "Wait... The summary generator is briefly overloaded. Showing raw preview instead.";
  }
}

async function rewriteQuery(query, chatHistory = []) {
  if (chatHistory.length === 0) return query;
  const historyText = chatHistory.slice(-3).map(m => `${m.role}: ${m.content}`).join("\n");

  try {
    const response = await groq.chat.completions.create({
      model: SUMMARY_MODEL, // 8B is perfect for simple rewrite tasks
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

async function summarizePaperSection(sectionName, sectionText) {
  console.log(`🧠 [Groq] Summarizing section: ${sectionName}`);
  try {
    return await withRetry(async () => {
      const response = await groq.chat.completions.create({
        model: SUMMARY_MODEL,
        messages: [
          {
            role: "system",
            content: `You are an expert academic summarizer specializing in research papers.
Rules:
- Summarize the provided section in 100-150 words
- Preserve technical terms and specific metrics exactly as written  
- Use active voice and formal academic tone
- Start directly with the content — no preamble like "This section discusses..."
- If the section contains numerical results, include them
- Do not speculate or add information not in the text`
          },
          {
            role: "user",
            content: `SECTION NAME: ${sectionName}\n\nCONTENT:\n${sectionText.slice(0, 4000)}`
          }
        ],
        temperature: 0.2,
      });
      return response.choices[0].message.content.trim();
    });
  } catch (error) {
    console.error(`❌ Groq Section Summary Error (${sectionName}):`, error.message);
    // Fallback: return a smart snippet instead of an error message
    const snippet = sectionText.slice(0, 400).trim();
    return snippet + (sectionText.length > 400 ? "..." : "");
  }
}

async function generateFollowUpSuggestions(question, answer, paperTitle) {
  console.log("🧠 [Groq] Generating follow-up suggestions...");
  try {
    const response = await groq.chat.completions.create({
      model: SUMMARY_MODEL, // Fast 8B model
      messages: [
        {
          role: "system",
          content: `You are a research assistant. Given a question and answer about a research paper, generate exactly 3 short follow-up questions a researcher would naturally ask next. Return ONLY a valid JSON array of 3 strings. 
          Example: ["What dataset was used?", "What are the limitations?", "How does this compare to prior work?"]
          No explanation. No markdown. Just the JSON array.`
        },
        {
          role: "user",
          content: `Question: ${question}\nAnswer: ${answer}\nPaper topic: ${paperTitle}`
        }
      ],
      max_tokens: 150,
      temperature: 0.4
    });

    const content = response.choices[0].message.content.trim();
    // Groq might return JSON inside markdown or plain. Let's try to parse.
    try {
      // Find possible array start/end if it returned noise
      const start = content.indexOf('[');
      const end = content.lastIndexOf(']') + 1;
      if (start !== -1 && end !== 0) {
        return JSON.parse(content.slice(start, end));
      }
      return JSON.parse(content);
    } catch (e) {
      console.error("❌ Suggestion Parse Error:", e, content);
      throw e;
    }
  } catch (error) {
    console.error("❌ Groq Suggestion Error:", error.message);
    return [
      "What methodology did the authors use?",
      "What are the main limitations of this study?",
      "How do these findings compare to related work?"
    ];
  }
}

async function generateComparison(question, labeledContext, streamCallback) {
  console.log(`🧠 [Groq] Generating multi-paper comparison... | Model: ${CHAT_MODEL} | Context chunks: ${labeledContext.length}`);
  
  // Group context by label
  const groupedContext = {};
  labeledContext.forEach(c => {
    if (!groupedContext[c.paperLabel]) {
      groupedContext[c.paperLabel] = { title: c.paperTitle, chunks: [] };
    }
    groupedContext[c.paperLabel].chunks.push(c.chunkText);
  });

  let contextStr = "";
  for (const [label, data] of Object.entries(groupedContext)) {
    contextStr += `[${label}] (${data.title}):\n${data.chunks.join("\n")}\n\n`;
  }

  const messages = [
    {
      role: "system",
      content: `You are an expert research analyst comparing multiple academic papers.
You will be given excerpts from several papers, each labeled [Paper A], [Paper B], etc.

RULES:
1. ALWAYS cite which paper each point comes from using [Paper A], [Paper B] notation.
2. Be analytical and comparative — don't just summarize each paper separately.
3. Highlight agreements, contradictions, and unique contributions.
4. If only one paper addresses a point, say so explicitly.
5. Be concise but thorough. Use markdown for structure (bullet points, bold text).`
    },
    {
      role: "user",
      content: `User Question: "${question}"\n\nContext from papers:\n${contextStr}\n\nAnswer comparatively, citing [Paper A], [Paper B] etc. for each point.`
    }
  ];

  try {
    const fullText = await readStreamWithTimeout(
      groq.chat.completions.create({
        model: CHAT_MODEL,
        messages: messages,
        temperature: 0.3,
        max_tokens: 1000,
        stream: true,
      }),
      streamCallback
    );
    return fullText;
  } catch (error) {
    console.error("❌ Groq Comparison Error:", error.message);
    // Fallback to 8B model on rate limit
    if (error.status === 429 || error.message?.includes('429')) {
      console.log('🔄 429 Detected: Falling back to 8B model for comparison...');
      if (streamCallback) streamCallback('\n\n[⚡ Switched to fast model due to rate limits]\n\n');
      try {
        const fallbackText = await readStreamWithTimeout(
          groq.chat.completions.create({ model: SUMMARY_MODEL, messages, temperature: 0.3, max_tokens: 1000, stream: true }),
          streamCallback
        );
        return fallbackText;
      } catch (fbErr) {
        console.error('❌ Comparison fallback also failed:', fbErr.message);
      }
    }
    const errorMsg = `⚠️ Comparison failed: ${error.message}`;
    if (streamCallback) streamCallback(errorMsg);
    return errorMsg;
  }
}

async function generateLiteratureReview(contextParts, streamCallback) {
  console.log(`🧠 [Groq] Generating automated literature review... | Model: ${CHAT_MODEL} | Papers: ${contextParts.length}`);
  
  const contextText = contextParts.map((p, i) =>
    `[Paper ${i + 1}] "${p.title}" (${p.year || 'n.d.'}) by ${(p.authors || []).slice(0, 2).join(', ')}:\nAbstract/Summary: ${p.summary || ''}\nKey Findings: ${p.conclusion || ''}`
  ).join('\n\n---\n\n');

  const messages = [
    {
      role: "system",
      content: `You are an expert academic writer synthesizing multiple research papers into a cohesive literature review.
Given summaries and excerpts of multiple papers, write a structured literature review.

You MUST include these exact sections (using markdown headers ##):
## Overview
## Common Themes & Agreements
## Contradictions & Debates
## Research Gaps & Future Directions
## Conclusion

RULES:
1. Be specific and heavily cite papers by their provided title or authors.
2. Write in a formal, academic style.
3. Don't simply list paper summaries. Synthesize the findings into a narrative.
4. Keep the total length around 500-700 words.
5. Do not include introductory conversational filler like "Here is the review".`
    },
    {
      role: "user",
      content: `Context from papers:\n\n${contextText}`
    }
  ];

  try {
    const fullText = await readStreamWithTimeout(
      groq.chat.completions.create({
        model: CHAT_MODEL,
        messages: messages,
        temperature: 0.3,
        max_tokens: 1500,
        stream: true,
      }),
      streamCallback
    );
    return fullText;
  } catch (error) {
    console.error("❌ Groq Lit Review Error:", error.message);
    // Fallback to 8B model on rate limit
    if (error.status === 429 || error.message?.includes('429')) {
      console.log('🔄 429 Detected: Falling back to 8B model for lit review...');
      if (streamCallback) streamCallback('\n\n[⚡ Switched to fast model due to rate limits]\n\n');
      try {
        const fallbackText = await readStreamWithTimeout(
          groq.chat.completions.create({ model: SUMMARY_MODEL, messages, temperature: 0.3, max_tokens: 1500, stream: true }),
          streamCallback
        );
        return fallbackText;
      } catch (fbErr) {
        console.error('❌ Lit review fallback also failed:', fbErr.message);
      }
    }
    const errorMsg = `⚠️ Literature review failed: ${error.message}`;
    if (streamCallback) streamCallback(errorMsg);
    return errorMsg;
  }
}

async function generateMethodologyCritique(paperData, streamCallback) {
  console.log("🧠 [Groq] Generating methodology critique...");
  
  // Extract methodology/results sections or use summary fallback
  const sections = paperData.sections || {};
  let contextStr = "Title: " + paperData.title + "\n";
  if (sections.methodology || sections.methods) contextStr += "Methodology: " + (sections.methodology || sections.methods) + "\n";
  if (sections.results) contextStr += "Results: " + sections.results + "\n";
  
  // Failsafe if we couldn't easily parse methodology headers
  if (contextStr.length < 200 && paperData.summaryPreview) {
      contextStr += "Summary: " + paperData.summaryPreview + "\n";
  }

  const messages = [
    {
      role: "system",
      content: `You are a critical peer reviewer analyzing a research paper's methodology and findings.
Focus strictly on identifying potential weaknesses, biases, and limitations.

You MUST systematically analyze the text for:
1. Sample size & statistical validity concerns
2. Potential confounds or biases not addressed by the authors
3. Limitations the authors may have brushed off or understated
4. Reproducibility concerns
5. Claims that appear unsupported by the data presented

RULES:
- Be highly specific, constructive, and academic.
- Use bullet points and markdown for clear structure.
- Do NOT provide a generic summary—you are providing a critique.`
    },
    {
      role: "user",
      content: `Paper Context:\n\n${contextStr}`
    }
  ];

  try {
    const fullText = await readStreamWithTimeout(
      groq.chat.completions.create({
        model: CHAT_MODEL,
        messages: messages,
        temperature: 0.4,
        max_tokens: 1000,
        stream: true,
      }),
      streamCallback
    );
    return fullText;
  } catch (error) {
    console.error("❌ Groq Critique Error:", error.message);
    throw error;
  }
}

async function generateFlashcards(paperData) {
  console.log("🧠 [Groq] Generating interactive flashcards...");
  
  let contextStr = "Title: " + paperData.title + "\n";
  if (paperData.summaryPreview) contextStr += "Summary: " + paperData.summaryPreview + "\n";
  const sections = paperData.sections || {};
  if (sections.abstract) contextStr += "Abstract: " + sections.abstract + "\n";
  if (sections.conclusion) contextStr += "Conclusion: " + sections.conclusion + "\n";

  try {
    const response = await groq.chat.completions.create({
      model: SUMMARY_MODEL, // Fast model
      messages: [
        {
          role: "system",
          content: `You are an expert tutor extracting key knowledge from a research paper. 
Generate exactly 8 study flashcards from the provided paper context.

RULES:
1. Cover: Key definitions, main methodology, core findings, and important limitations.
2. Return ONLY a valid JSON array of objects.
3. No conversational text or markdown formatting outside the JSON array.
4. Each object must have exactly two keys: "front" (a question or concept) and "back" (the concise answer or definition).

Example format:
[
  {"front": "What was the primary objective of this study?", "back": "To evaluate the efficacy of Treatment X on Disease Y over 6 months."},
  {"front": "What was the sample size?", "back": "N=450 double-blind participants."}
]`
        },
        {
          role: "user",
          content: `Paper Context:\n\n${contextStr}`
        }
      ],
      temperature: 0.3,
      response_format: { type: "json_object" }
    });

    const content = response.choices[0].message.content.trim();
    try {
      const start = content.indexOf('[');
      const end = content.lastIndexOf(']') + 1;
      if (start !== -1 && end !== 0) {
        return JSON.parse(content.slice(start, end));
      }
      return JSON.parse(content);
    } catch (e) {
      console.error("❌ Flashcard Parse Error:", e, content);
      return []; // empty fallback
    }
  } catch (error) {
    console.error("❌ Groq Flashcard Error:", error.message);
    return [];
  }
}

module.exports = { 
  generateSummary, 
  generateStructuredSummary, 
  rewriteQuery, 
  summarizePaperSection, 
  generateFollowUpSuggestions,
  generateComparison,
  generateLiteratureReview,
  generateMethodologyCritique,
  generateFlashcards
};
