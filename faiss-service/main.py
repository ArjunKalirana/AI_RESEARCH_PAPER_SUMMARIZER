import faiss
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import os

app = FastAPI()

DIMENSION = 384
INDEX_PATH = "index_store/faiss.index"

os.makedirs("index_store", exist_ok=True)

# Load embedding model
model = SentenceTransformer("all-MiniLM-L6-v2")

# Load or create FAISS index
if os.path.exists(INDEX_PATH):
    index = faiss.read_index(INDEX_PATH)
else:
    index = faiss.IndexFlatIP(DIMENSION)

class TextInput(BaseModel):
    texts: list

class SearchInput(BaseModel):
    query: str

@app.post("/add")
def add_texts(data: TextInput):
    embeddings = model.encode(data.texts)
    embeddings = np.array(embeddings).astype("float32")
    faiss.normalize_L2(embeddings)

    start_index = index.ntotal
    index.add(embeddings)
    end_index = index.ntotal - 1

    faiss.write_index(index, INDEX_PATH)

    return {
        "status": "added",
        "start_index": start_index,
        "end_index": end_index,
        "total_vectors": index.ntotal
    }

@app.post("/search")
def search_text(data: SearchInput):
    query_embedding = model.encode([data.query])
    query_embedding = np.array(query_embedding).astype("float32")
    faiss.normalize_L2(query_embedding)

    D, I = index.search(query_embedding, 5)

    return {
        "distances": D.tolist(),
        "indices": I.tolist()
    }
