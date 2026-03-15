import faiss
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
from typing import List, Any
import os
import json

app = FastAPI()

DIMENSION = 384
os.makedirs("index_store", exist_ok=True)

model = SentenceTransformer("all-MiniLM-L6-v2")

class IndexInput(BaseModel):      # ✅ ADD THIS
    index_id: str
    chunks: List[Any]

class TextInput(BaseModel):
    index_id: str
    texts: list

class SearchInput(BaseModel):
    index_id: str
    query: str
    k: int = 5

class SentencePair(BaseModel):
    text1: str
    text2: str

@app.post("/index")
def build_index(data: IndexInput):
    os.makedirs("index_store", exist_ok=True)

    # ✅ FIX: Sort chunks by chunkIndex to guarantee position alignment
    sorted_chunks = sorted(data.chunks, key=lambda c: c["chunkIndex"])

    texts = [chunk["chunkText"] for chunk in sorted_chunks]

    if not texts:
        return {"error": "No chunks provided"}

    # Encode all chunk texts
    embeddings = model.encode(texts, batch_size=32, show_progress_bar=False)
    embeddings = np.array(embeddings).astype("float32")

    # Normalize for cosine similarity
    faiss.normalize_L2(embeddings)

    # Build flat index (exact search — fine for single paper)
    index = faiss.IndexFlatIP(DIMENSION)
    index.add(embeddings)

    # Save index
    index_path = f"index_store/{data.index_id}.index"
    faiss.write_index(index, index_path)

    # ✅ Also save the sorted chunk order as a manifest
    # This allows future verification that row N == chunkIndex N
    manifest_path = f"index_store/{data.index_id}.manifest.json"
    manifest = [{"row": i, "chunkIndex": c["chunkIndex"]} for i, c in enumerate(sorted_chunks)]
    with open(manifest_path, "w") as f:
        json.dump(manifest, f)

    return {
        "status": "indexed",
        "total_chunks": index.ntotal,
        "index_id": data.index_id
    }

@app.post("/search")
def search_text(data: SearchInput):
    index_path = f"index_store/{data.index_id}.index"
    if not os.path.exists(index_path):
        return {"distances": [], "indices": []}

    index = faiss.read_index(index_path)

    query_embedding = model.encode([data.query])
    query_embedding = np.array(query_embedding).astype("float32")
    faiss.normalize_L2(query_embedding)

    k = min(data.k, index.ntotal)
    if k == 0:
        return {"distances": [], "indices": []}

    D, I = index.search(query_embedding, k)

    return {
        "distances": D.tolist(),
        "indices": I.tolist()
    }

@app.post("/similarity")
def compute_similarity(data: SentencePair):
    emb1 = model.encode([data.text1])
    emb2 = model.encode([data.text2])
    
    emb1 = np.array(emb1).astype("float32")
    emb2 = np.array(emb2).astype("float32")
    faiss.normalize_L2(emb1)
    faiss.normalize_L2(emb2)
    
    similarity = np.dot(emb1[0], emb2[0])
    
    return {
        "similarity": float(similarity)
    }
