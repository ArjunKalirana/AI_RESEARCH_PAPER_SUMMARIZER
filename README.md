# 🧪 ResearchAI: The Intelligent Academic Assistant

ResearchAI is a state-of-the-art Research Assistant platform designed to streamline academic workflows. Leveraging **High-Performance RAG (Retrieval-Augmented Generation)**, **Groq-powered Llama 3**, and **Fast Vector Search**, it empowers researchers to synthesize, analyze, and interact with academic papers at scale.

---

## ✨ Features

### 📄 Smart Paper Library
*   **Centralized Management**: Seamlessly upload, tag, and organize your research library.
*   **Paper Indexing**: Automatic text extraction and vectorization for instant retrieval.
*   **Semantic Search**: Find specific concepts across your entire collection, not just keywords.

### 🤖 Researcher AI Chat (RAG)
*   **Multi-Paper Context**: Ask questions across a single paper or your entire selection.
*   **Confidence Scores**: Transparency in AI reasoning with real-time groundedness metrics.
*   **Source Attribution**: Pinpoint exactly where in the paper the AI found the answer.
*   **Streaming Responses**: Real-time insights via Socket.io for a near-instant experience.

### ✍️ Advanced Academic Synthesis
*   **Literature Reviews**: Generate comprehensive syntheses across multiple studies in seconds.
*   **Structural Summaries**: Instant breakdowns of Problem, Approach, Methodology, Results, and Contribution.
*   **Comparison Engine**: Analyze methodological differences and result variations side-by-side.

### 📝 Integrated Study Tools
*   **Sticky Note Annotations**: Highlight key passages and attach your own research notes.
*   **AI Flashcards**: Automatically generate study aids based on complex paper concepts.
*   **Export Center**: One-click exports to PDF, BibTeX, APA, and MLA formats.

---

## 🛠️ Technology Stack

| Layer | Technologies |
| :--- | :--- |
| **Frontend** | HTML5, **Tailwind CSS**, Vanilla JavaScript, **Socket.io**, PDF.js |
| **Backend** | **Node.js (Express)**, SQLite3 (Auth), **Neo4j** (Graph References) |
| **AI / LLM** | **Groq SDK (Llama 3 70B)**, FAISS (Vector Store), Python (FastAPI) |
| **DevOps** | Railway, Docker / Nixpacks |

---

## 📂 Project Structure

```text
├── project-root/       # Main Node.js Express server
│   ├── app.js          # Core application logic
│   ├── routes/         # API endpoints (Auth, Library, AI, Export)
│   ├── frontend/       # Web assets (HTML, CSS, JS)
│   └── scripts/        # Background processing & embedding tools
├── faiss-service/      # Python microservice for vector operations
│   └── main.py         # FastAPI frontend for FAISS
└── README.md           # You are here
```

---

## 🚀 Getting Started

### 1. Environment Configuration
Create a `.env` file in `project-root/` based on `.env.example`:
```env
GROQ_API_KEY="your_groq_key"
NEO4J_URI="bolt://..."
NEO4J_USER="neo4j"
NEO4J_PASSWORD="..."
JWT_SECRET="..."
```

### 2. Start the Vector Microservice
The Python service handles high-speed similarity search for RAG.
```bash
cd faiss-service
pip install -r requirements.txt
uvicorn main:app --port 8000
```

### 3. Build & Run the Main Platform
```bash
cd project-root
npm install
npm run build   # Compiles Tailwind CSS
npm start
```
*Access the platform at `http://localhost:3000`*

---

## 📜 License
This project is licensed under the **ISC License**.

---
*Powered by Groq and Llama 3.*
