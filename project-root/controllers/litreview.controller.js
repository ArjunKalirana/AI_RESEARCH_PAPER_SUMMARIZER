const fs = require('fs');
const path = require('path');
const { generateLiteratureReview } = require('../services/llmService');

const OUTPUT_DIR = path.join(process.cwd(), 'output');

exports.generateLitReview = async (req, res) => {
    try {
        const { paperIds } = req.body;

        if (!paperIds || !Array.isArray(paperIds) || paperIds.length < 2) {
            return res.status(400).json({ error: 'Please provide at least two paper IDs to generate a literature review.' });
        }

        // Setup SSE response
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Load & aggregate data
        let contextParts = [];

        for (const pid of paperIds) {
            const paperPath = path.join(OUTPUT_DIR, `${pid}.json`);
            if (!fs.existsSync(paperPath)) {
                return res.write(`data: ${JSON.stringify({ error: `Paper ${pid} not found.` })}\n\n`);
            }
            
            const p = JSON.parse(fs.readFileSync(paperPath, 'utf8'));
            const title = p.title || 'Unknown Title';
            const year = p.year || 'Unknown Year';
            const authors = p.author_names ? p.author_names.join(', ') : 'Unknown Authors';
            
            // Build text context for this paper
            let textContext = `### Paper: ${title} (${year})\nAuthors: ${authors}\n`;
            if (p.summaryPreview) textContext += `Summary: ${p.summaryPreview}\n`;
            if (p.sections) {
                if (p.sections.abstract) textContext += `Abstract: ${p.sections.abstract}\n`;
                if (p.sections.conclusion) textContext += `Conclusion: ${p.sections.conclusion}\n`;
            }
            contextParts.push(textContext);
        }

        const combinedContext = contextParts.join('\n\n---\n\n');

        // Generate via Groq using LLM Service
        // We'll pass a callback to stream the chunks correctly wrapped in SSE format
        await generateLiteratureReview(combinedContext, (chunk) => {
            res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
        });

        // End of stream
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();

    } catch (error) {
        console.error('❌ Controller LitReview Error:', error);
        res.write(`data: ${JSON.stringify({ error: error.message || 'Failed to generate literature review' })}\n\n`);
        res.end();
    }
};
