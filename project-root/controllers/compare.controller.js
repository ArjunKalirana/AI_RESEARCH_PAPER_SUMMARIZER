const fs = require('fs');
const path = require('path');
const { searchQuery } = require('../services/faissService');
const { runQuery } = require('../services/neo4j.service');
const { generateComparison, rewriteQuery, generateFollowUpSuggestions } = require('../services/llmService');

const processedPath = path.join(__dirname, '../data/processed_papers');

/**
 * Handles multi-paper comparison questions via Socket.io
 */
async function compareQuestion(req, res) {
    try {
        const { socketId, paperIds, question } = req.body;
        const io = req.app.get('io');

        if (!socketId) {
            return res.status(400).json({ error: 'socketId is required for streaming.' });
        }

        if (!Array.isArray(paperIds) || paperIds.length < 2 || paperIds.length > 5 || !question) {
            return res.status(400).json({ error: 'Please select 2-5 papers and provide a question.' });
        }

        const sendSocket = (event, data) => {
            if (io) io.to(socketId).emit(event, data);
        };

        // Acknowledge immediate request
        res.json({ success: true, message: "Comparison started via Socket.io" });

        sendSocket('compare:status', { status: 'processing', message: 'Searching and analyzing multiple papers...' });
        console.log(`[Compare] Socket.io comparison started for ${socketId}`);

        const refinedQuery = question;

        const searchResults = await Promise.all(
            paperIds.map(async (id) => {
                try {
                    return await searchQuery(refinedQuery, id, 5);
                } catch (e) {
                    console.error(`⚠️ Search failed for paper ${id}:`, e.message);
                    sendSocket('compare:warning', { warning: `Paper ID ${id.slice(0, 8)}... could not be searched. Skipping.` });
                    return null; 
                }
            })
        );

        const labeledContext = [];
        const paperLabels = {};
        const sources = [];
        const labels = ['Paper A', 'Paper B', 'Paper C', 'Paper D', 'Paper E'];

        for (let i = 0; i < paperIds.length; i++) {
            const paperId = paperIds[i];
            const label = labels[i];
            const result = searchResults[i];

            if (!result) continue;

            const neoRes = await runQuery(
                `MATCH (p:ResearchPaper {paperId: $paperId}) RETURN p.title AS title, p.year AS year`,
                { paperId }
            );
            const title = neoRes.records[0]?.get('title') || "Unknown Paper";
            paperLabels[label] = title;

            const paperPath = path.join(processedPath, `${paperId}.json`);
            if (fs.existsSync(paperPath)) {
                const paperData = JSON.parse(fs.readFileSync(paperPath, 'utf-8'));
                
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
                                score: dist
                            });
                            sources.push({ label, section: chunk.sectionName || "Context" });
                        }
                    }
                }
            }
        }

        labeledContext.sort((a, b) => b.score - a.score);

        let totalWords = 0;
        const truncatedContext = [];
        const MAX_WORDS = 3000;

        for (const ctx of labeledContext) {
            const wordCount = ctx.chunkText.split(/\s+/).length;
            if (totalWords + wordCount <= MAX_WORDS) {
                truncatedContext.push(ctx);
                totalWords += wordCount;
            } else {
                break;
            }
        }

        if (truncatedContext.length === 0) {
            sendSocket('compare:chunk', { chunk: "I couldn't find enough relevant information across these papers to make a comparison." });
            sendSocket('compare:final', { sources: [], paperLabels: {} });
            return;
        }

        console.log(`📊 [Compare] Context ready: ${truncatedContext.length} chunks. Starting LLM...`);
        const answer = await generateComparison(question, truncatedContext, (chunk) => {
            sendSocket('compare:chunk', { chunk });
        });

        console.log(`✅ [Compare] Answer generated: ${typeof answer === 'string' ? answer.length : 0} chars`);

        sendSocket('compare:final', {
            paperLabels,
            sources
        });

        generateFollowUpSuggestions(question, answer, "Multiple Research Papers")
            .then(suggestions => {
                sendSocket('compare:suggestions', { suggestions });
            })
            .catch(() => {});

    } catch (error) {
        console.error('❌ Compare API Error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to process comparison' });
        } else {
            if (io && req.body?.socketId) {
                io.to(req.body.socketId).emit('compare:error', { error: 'An error occurred during comparison generation.' });
            }
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
