# AI Research Paper Summarizer

An intelligent retrieval-augmented generation (RAG) system designed to summarize and extract insights from research papers. The application consists of a clean web frontend, an Express-based API gateway, and a fast vector similarity search microservice.

## Features
- **Upload & Process Papers**: Accept PDF unstructured data and index them for quick retrieval.
- **Automated Summarization**: Generate high-quality structure summaries of academic papers using Large Language Models (LLMs) emphasizing Problem, Approach, Methodology, Results, and Contribution.
- **AI Question Answering**: Query the system about specific details from the uploaded papers and receive accurate, context-aware answers.
- **High-Performance Vector Search**: Uses FAISS via a dedicated microservice for rapid similarity indexing and text chunk retrieval.

## Project Structure
- `frontend/`: HTML, CSS, and JS files comprising the UI (`code.html`, `code1.html`, etc.).
- `project-root/`: The main Node.js (Express) backend server orchestrating the operations, routing APIs, and coordinating with the LLMs and vector database.
- `faiss-service/`: A Python (FastAPI) microservice that handles vector embeddings, managing the FAISS indexing and performing lightning-fast similarity lookups.

## Technologies Used
- **Frontend**: HTML5, Canvas, PDF.js
- **Backend**: Node.js, Express, Axios, Multer
- **Vector DB/Embeddings**: Python, FastAPI, Uvicorn, Pydantic, FAISS-CPU, Numpy
- **Database/Storage**: Neo4j (Graph references), FAISS Index Stores
- **AI Integrations**: OpenAI API

## Prerequisites
- **Node.js**: v18+ recommended
- **Python**: v3.8+ recommended
- An active **OpenAI API Key**
- (Optional but recommended) A running Neo4j instance if graph functionalities are further utilized

## Installation & Setup

### 1. Configure Environment Variables
Inside `project-root/`, create a `.env` file containing your secrets. For example:
```env
OPENAI_API_KEY="your_openai_api_key_here"
PORT=3000
```

### 2. Start the FAISS Microservice
Navigate to the `faiss-service` directory, initialize a virtual environment, install dependencies, and run the FastAPI server:

```bash
cd faiss-service
python -m venv venv

# On Windows (PowerShell/CMD):
venv\Scripts\activate
# On Linux/MacOS:
# source venv/bin/activate

pip install -r requirements.txt
uvicorn main:app --port 8000
```
This runs the FAISS vector database wrapper service on `http://localhost:8000`.

### 3. Start the Node.js Express Server
In a new terminal, navigate to `project-root`, install dependencies, and start the app:

```bash
cd project-root
npm install
node app.js
```
The server will start running on `http://localhost:3000`. 
*(Note: It is also configured to serve the static frontend folder by default.)*

### 4. Access the Interface
Open your browser and navigate to `http://localhost:3000/code.html` (or open the `.html` files directly from the `frontend` folder). Upload a PDF paper to begin.

## License
MIT License
