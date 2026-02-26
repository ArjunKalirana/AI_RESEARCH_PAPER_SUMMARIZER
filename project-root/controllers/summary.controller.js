const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data/processed_papers');

async function getSummary(req, res) {
  try {
    const { paperId } = req.params;
    
    // Validate paperId
    if (!paperId || typeof paperId !== 'string') {
      return res.status(400).json({ error: 'Invalid paper ID' });
    }

    // Sanitize to prevent path traversal
    const cleanPaperId = path.basename(paperId);
    const filePath = path.join(DATA_DIR, `${cleanPaperId}.json`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Paper summary not found' });
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const paperData = JSON.parse(fileContent);

    // Filter fields to avoid sending unnecessary large data like all raw chunks
    const responsePayload = {
      title: paperData.title,
      authors: paperData.authors,
      year: paperData.year,
      summary: paperData.summaryPreview || "No summary available.",
      sections: paperData.sections
    };

    res.json(responsePayload);
  } catch (error) {
    console.error('❌ Summary Route Error:', error);
    res.status(500).json({ error: 'Failed to retrieve paper summary' });
  }
}

module.exports = {
  getSummary
};
