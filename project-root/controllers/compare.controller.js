const fs = require('fs');
const path = require('path');
const { searchQuery } = require('../services/faissService');
const { runQuery } = require('../services/neo4j.service');
const { generateComparison, rewriteQuery, generateFollowUpSuggestions } = require('../services/llmService');

const processedPath = path.join(__dirname, '../data/processed_papers');

/**
 * Handles multi-paper comparison questions via SSE
 */
async function compareQuestion(req, res) {
    let isStreamClosed = false;
    let keepalive;
    req.on('close', () => { isStreamClosed = true; });

    const sendSSE = (data) => {
        if (isStreamClosed || res.writableEnded) return;
        try {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            flushRes();
        } catch (e) {
            console.error("[SSE] Write failed:", e.message);
        }
    };

    const flushRes = () => {
        if (typeof res.flush === 'function') res.flush();
        else if (res.socket && !res.socket.destroyed) res.socket.uncork?.();
    };

    try {
        const { paperIds, question } = req.body;

        if (!Array.isArray(paperIds) || paperIds.length < 2 || paperIds.length > 5 || !question) {
            return res.status(400).json({ error: 'Please select 2-5 papers and provide a question.' });
        }

        // Headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Content-Encoding', 'identity');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // Force TCP to send data immediately
        if (res.socket) {
            res.socket.setNoDelay(true);
            res.socket.setTimeout(0);
        }

        // Send initial event IMMEDIATELY to establish stream through Railway's HTTP/2 proxy
        res.write('data: {"status":"processing"}\n\n');

        // Keepalive with real data events (proxies may strip SSE comments)
        keepalive = setInterval(() => {
            if (!isStreamClosed && !res.writableEnded) {
                res.write('data: {"heartbeat":true}\n\n');
            }
        }, 8000);

        // No history in comparison mode — use question directly, skip the Groq call
        const refinedQuery = question;

        // 2. Parallel Search across all indices (Resilient)
        const searchResults = await Promise.all(
            paperIds.map(async (id) => {
                try {
                    return await searchQuery(refinedQuery, id, 5);
                } catch (e) {
                    console.error(`⚠️ Search failed for paper ${id}:`, e.message);
                    sendSSE({ warning: `Paper ID ${id.slice(0, 8)}... could not be searched (index missing or service down). Skipping.` });
                    return null; 
                }
            })
        );

        // 3. Resolve context and metadata
        const labeledContext = [];
        const paperLabels = {};
        const sources = [];

        const labels = ['Paper A', 'Paper B', 'Paper C', 'Paper D', 'Paper E'];

        for (let i = 0; i < paperIds.length; i++) {
            const paperId = paperIds[i];
            const label = labels[i];
            const result = searchResults[i];

            if (!result) continue; // Skip failed search

            // Fetch Title/Year from Neo4j (for mapping)
            const neoRes = await runQuery(
                `MATCH (p:ResearchPaper {paperId: $paperId}) RETURN p.title AS title, p.year AS year`,
                { paperId }
            );
            const title = neoRes.records[0]?.get('title') || "Unknown Paper";
            paperLabels[label] = title;

            // Load Paper JSON for chunk text
            const paperPath = path.join(processedPath, `${paperId}.json`);
            if (fs.existsSync(paperPath)) {
                const paperData = JSON.parse(fs.readFileSync(paperPath, 'utf-8'));
                
                // Handle Reranker results if present
                if (result.results && result.results.length > 0) {
                    for (const chunk of result.results) {
                        labeledContext.push({
                            paperId,
                            paperTitle: title,
                            paperLabel: label,
                            chunkText: chunk.text,
                            section: chunk.sectionName || "Context",
                            score: chunk.score || 0
                        });
                        sources.push({ label, section: chunk.sectionName || "Context" });
                    }
                } else {
                    // Fallback to basic indices
                    const allIndices = Array.isArray(result.indices) ? (Array.isArray(result.indices[0]) ? result.indices[0] : result.indices) : [];
                    const allDistances = Array.isArray(result.distances) ? (Array.isArray(result.distances[0]) ? result.distances[0] : result.distances) : [];
                    
                    for (let j = 0; j < allIndices.length; j++) {
                        const idx = allIndices[j];
                        const dist = allDistances[j];
                        const chunk = paperData.chunks[idx];
                        if (chunk && dist >= 0.25) {
                            labeledContext.push({
                                paperId,
                                paperTitle: title,
                                paperLabel: label,
                                chunkText: chunk.chunkText,
                                section: chunk.sectionName || "Context",
                                score: dist // Distance as score
                            });
                            sources.push({ label, section: chunk.sectionName || "Context" });
                        }
                    }
                }
            }
        }

        // --- SMART TRUNCATION (3000 Words Limit) ---
        // 1. Sort by similarity score across all papers
        labeledContext.sort((a, b) => b.score - a.score);

        // 2. Greedy selection to stay within word budget
        let totalWords = 0;
        const truncatedContext = [];
        const MAX_WORDS = 3000;

        for (const ctx of labeledContext) {
            const wordCount = ctx.chunkText.split(/\s+/).length;
            if (totalWords + wordCount <= MAX_WORDS) {
                truncatedContext.push(ctx);
                totalWords += wordCount;
            } else {
                console.log(`✂️ Truncating context. Limit reached at ${totalWords} words.`);
                break;
            }
        }

        if (truncatedContext.length === 0) {
            sendSSE({ chunk: "I couldn't find enough relevant information across these papers to make a comparison." });
            sendSSE({ final: true, sources: [], paperLabels: {} });
            clearInterval(keepalive);
            return res.end();
        }

        // 4. Generate Comparison with Streaming
        console.log(`📊 [Compare] Context ready: ${truncatedContext.length} chunks, ${totalWords} words. Starting LLM...`);
        const answer = await generateComparison(question, truncatedContext, (chunk) => {
            sendSSE({ chunk });
        });

        console.log(`✅ [Compare] Answer generated: ${typeof answer === 'string' ? answer.length : 0} chars`);
        if (isStreamClosed) return;

        // 5. Send final event immediately — don't block on suggestions
        clearInterval(keepalive);
        sendSSE({
            final: true,
            paperLabels,
            sources
        });

        // Generate suggestions async AFTER final — they arrive as a follow-up event
        if (!isStreamClosed) {
            generateFollowUpSuggestions(question, answer, "Multiple Research Papers")
                .then(suggestions => {
                    if (!isStreamClosed && !res.writableEnded) {
                        sendSSE({ suggestions });
                    }
                })
                .catch(() => {})
                .finally(() => {
                    if (!res.writableEnded) res.end();
                });
        } else {
            if (!res.writableEnded) res.end();
        }

    } catch (error) {
        clearInterval(keepalive);
        console.error('❌ Compare API Error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to process comparison' });
        } else {
            sendSSE({ error: 'An error occurred during comparison generation.' });
            res.end();
        }
    }
}

/**
 * Returns a list of all processed papers for the selector
 */
async function getPapers(req, res) {
    try {
        if (!fs.existsSync(processedPath)) {
            return res.json([]);
        }

        const files = fs.readdirSync(processedPath).filter(f => f.endsWith('.json'));
        const papers = files.map(file => {
            const data = JSON.parse(fs.readFileSync(path.join(processedPath, file), 'utf-8'));
            return {
                paperId: file.replace('.json', ''),
                title: data.title || "Untitled",
                authors: data.authors || [],
                year: data.year || "Unknown"
            };
        });

        res.json(papers);
    } catch (error) {
        console.error('❌ GetPapers Error:', error);
        res.status(500).json({ error: 'Failed to fetch papers list' });
    }
}

module.exports = { compareQuestion, getPapers };
