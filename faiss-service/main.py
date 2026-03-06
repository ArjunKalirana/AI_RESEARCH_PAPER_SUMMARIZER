import faiss
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import os

app = FastAPI()

DIMENSION = 384
os.makedirs("index_store", exist_ok=True)

# Load embedding model
model = SentenceTransformer("all-MiniLM-L6-v2")

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

@app.post("/add")
def add_texts(data: TextInput):
    index_path = f"index_store/{data.index_id}.index"
    
    if os.path.exists(index_path):
        index = faiss.read_index(index_path)
    else:
        index = faiss.IndexFlatIP(DIMENSION)

    embeddings = model.encode(data.texts)
    embeddings = np.array(embeddings).astype("float32")
    faiss.normalize_L2(embeddings)

    start_index = index.ntotal
    index.add(embeddings)
    end_index = index.ntotal - 1

    faiss.write_index(index, index_path)

    return {
        "status": "added",
        "index_id": data.index_id,
        "start_index": start_index,
        "end_index": end_index,
        "total_vectors": index.ntotal
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
