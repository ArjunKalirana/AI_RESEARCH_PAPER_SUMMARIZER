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
    req.on('close', () => { isStreamClosed = true; });

    const sendSSE = (data) => {
        if (isStreamClosed || res.writableEnded) return;
        try {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {
            console.error("[SSE] Write failed:", e.message);
        }
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
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // 1. Rewrite Query (standalone)
        const refinedQuery = await rewriteQuery(question, []); // No history for comparison mode

        // 2. Parallel Search across all indices
        const searchPromises = paperIds.map(id => searchQuery(refinedQuery, id, 5));
        const searchResults = await Promise.all(searchPromises);

        // 3. Resolve context and metadata
        const labeledContext = [];
        const paperLabels = {};
        const sources = [];

        const labels = ['Paper A', 'Paper B', 'Paper C', 'Paper D', 'Paper E'];

        for (let i = 0; i < paperIds.length; i++) {
            const paperId = paperIds[i];
            const label = labels[i];
            const result = searchResults[i];

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
                            section: chunk.sectionName || "Context"
                        });
                        sources.push({ label, section: chunk.sectionName || "Context" });
                    }
                } else {
                    // Fallback to basic indices
                    const allIndices = Array.isArray(result.indices) ? (Array.isArray(result.indices[0]) ? result.indices[0] : result.indices) : [];
                    const allDistances = Array.isArray(result.distances) ? (Array.isArray(result.distances[0]) ? result.distances[0] : result.distances) : [];
                    
                    for (let j = 0; j < allIndices.length; j++) {
                        const idx = allIndices[j];
                        const sim = allDistances[j];
                        const chunk = paperData.chunks[idx];
                        if (chunk && sim >= 0.25) {
                            labeledContext.push({
                                paperId,
                                paperTitle: title,
                                paperLabel: label,
                                chunkText: chunk.chunkText,
                                section: chunk.sectionName || "Context"
                            });
                            sources.push({ label, section: chunk.sectionName || "Context" });
                        }
                    }
                }
            }
        }

        if (labeledContext.length === 0) {
            sendSSE({ chunk: "I couldn't find enough relevant information across these papers to make a comparison." });
            sendSSE({ final: true, sources: [], paperLabels: {} });
            return res.end();
        }

        // 4. Generate Comparison with Streaming
        const answer = await generateComparison(question, labeledContext, (chunk) => {
            sendSSE({ chunk });
        });

        if (isStreamClosed) return;

        // 5. Suggestions & Final Event
        const suggestions = await generateFollowUpSuggestions(question, answer, "Multiple Research Papers");

        sendSSE({
            final: true,
            paperLabels,
            sources,
            suggestions
        });

        res.end();

    } catch (error) {
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
