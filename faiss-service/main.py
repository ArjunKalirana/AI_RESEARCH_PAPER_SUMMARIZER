import faiss
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer, CrossEncoder
from typing import List, Any
import os
import json
import logging

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("researchai")

app = FastAPI()

DIMENSION = 384
os.makedirs("index_store", exist_ok=True)

import gc

# ── 1. In-Memory Cache ────────────────────────────────────────────────────────
class IndexCache:
    def __init__(self, max_size=3):
        self.indices = {} # paper_id -> faiss_index
        self.chunks = {}  # paper_id -> list of chunk dicts
        self.order = []   # LRU tracking
        self.max_size = max_size

    def get(self, index_id):
        if index_id in self.indices:
            # Move to back (most recently used)
            if index_id in self.order:
                self.order.remove(index_id)
            self.order.append(index_id)
            return self.indices[index_id], self.chunks[index_id]
        
        # Load from disk
        index_path = f"index_store/{index_id}.index"
        chunks_path = f"index_store/{index_id}.chunks.json"
        
        if os.path.exists(index_path) and os.path.exists(chunks_path):
            try:
                print(f"📁 Cache Miss. Loading {index_id} from disk...")
                index = faiss.read_index(index_path)
                with open(chunks_path, "r") as f:
                    chunks = json.load(f)
                
                self._add(index_id, index, chunks)
                return index, chunks
            except Exception as e:
                print(f"❌ Failed to load {index_id} from disk: {e}")
                return None, None
        return None, None

    def _add(self, index_id, index, chunks):
        if len(self.order) >= self.max_size:
            oldest = self.order.pop(0)
            if oldest in self.indices: del self.indices[oldest]
            if oldest in self.chunks: del self.chunks[oldest]
            print(f"🧹 Evicted {oldest} and running garbage collector.")
            gc.collect() # 🚀 CRITICAL for small-memory containers
        
        self.indices[index_id] = index
        self.chunks[index_id] = chunks
        self.order.append(index_id)

index_cache = IndexCache(max_size=3)

# Bi-encoder: fast embedding model for FAISS retrieval
model = SentenceTransformer("all-MiniLM-L6-v2")

# Reranker disabled — too memory-intensive for Railway hobby tier.
# The /search-reranked endpoint will fall back to basic FAISS search.
reranker = None
logger.info("[startup] Reranker disabled to conserve memory. Using basic FAISS search.")

# ── Pydantic models ────────────────────────────────────────────────────────────

class IndexInput(BaseModel):
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

class RerankSearchInput(BaseModel):
    index_id: str
    query: str
    k: int = 5         # final number of results to return after reranking
    fetch_k: int = 20  # how many FAISS candidates to fetch before reranking


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "loaded_indices": list(index_cache.indices.keys()),
        "total_loaded": len(index_cache.indices),
        "reranker_available": reranker is not None
    }

@app.post("/rebuild-index")
@app.post("/index")
def build_index(data: IndexInput):
    os.makedirs("index_store", exist_ok=True)
    sorted_chunks = sorted(data.chunks, key=lambda c: c["chunkIndex"])
    texts = [chunk["chunkText"] for chunk in sorted_chunks]
    if not texts:
        return {"error": "No chunks provided"}

    embeddings = model.encode(texts, batch_size=32, show_progress_bar=False)
    embeddings = np.array(embeddings).astype("float32")
    faiss.normalize_L2(embeddings)

    index = faiss.IndexFlatIP(DIMENSION)
    index.add(embeddings)

    index_path = f"index_store/{data.index_id}.index"
    faiss.write_index(index, index_path)

    # Existing manifest (row → chunkIndex mapping)
    manifest_path = f"index_store/{data.index_id}.manifest.json"
    manifest = [{"row": i, "chunkIndex": c["chunkIndex"]} for i, c in enumerate(sorted_chunks)]
    with open(manifest_path, "w") as f:
        json.dump(manifest, f)

    # Save chunk texts for reranking retrieve
    chunks_path = f"index_store/{data.index_id}.chunks.json"
    chunks_store = [
        {"row": i, "chunkIndex": c["chunkIndex"], "text": c["chunkText"]}
        for i, c in enumerate(sorted_chunks)
    ]
    with open(chunks_path, "w") as f:
        json.dump(chunks_store, f)

    return {"status": "indexed", "total_chunks": index.ntotal, "index_id": data.index_id}


@app.post("/search")
def search_text(data: SearchInput):
    index, _ = index_cache.get(data.index_id)
    if not index:
        return {"distances": [], "indices": []}

    query_embedding = model.encode([data.query])
    query_embedding = np.array(query_embedding).astype("float32")
    faiss.normalize_L2(query_embedding)
    k = min(data.k, index.ntotal)
    if k == 0:
        return {"distances": [], "indices": []}
    D, I = index.search(query_embedding, k)
    return {"distances": D.tolist(), "indices": I.tolist()}


@app.post("/search-reranked")
def search_reranked(data: RerankSearchInput):
    # Reranker disabled for memory — fallback to basic search logic
    index, chunks_store = index_cache.get(data.index_id)
    if not index or not chunks_store:
        return {"results": []}

    query_embedding = model.encode([data.query])
    query_embedding = np.array(query_embedding).astype("float32")
    faiss.normalize_L2(query_embedding)

    # Use k or fetch_k depending on what the frontend requested
    search_k = min(data.k, index.ntotal)
    if search_k == 0:
        return {"results": []}

    D, I = index.search(query_embedding, search_k)
    faiss_distances = D[0].tolist()
    faiss_indices   = I[0].tolist()

    results = []
    for row, faiss_score in zip(faiss_indices, faiss_distances):
        if row == -1: continue
        
        # Match row index from FAISS with chunk in chunks_store
        chunk = next((c for c in chunks_store if c["row"] == row), None)
        if not chunk: continue
        
        results.append({
            "row":          row,
            "chunkIndex":   chunk.get("chunkIndex", row),
            "text":         chunk.get("text", ""),
            "faiss_score":  faiss_score,
            "rerank_score": faiss_score  # Fallback: use FAISS score as rerank score
        })

    return {"results": results}


@app.delete("/delete-index/{index_id}")
def delete_index(index_id: str):
    index_path = f"index_store/{index_id}.index"
    manifest_path = f"index_store/{index_id}.manifest.json"
    chunks_path = f"index_store/{index_id}.chunks.json"
    
    deleted = []
    for path in [index_path, manifest_path, chunks_path]:
        if os.path.exists(path):
            os.remove(path)
            deleted.append(path)
            
    # Remove from cache if present
    if index_id in index_cache.indices:
        del index_cache.indices[index_id]
        if index_id in index_cache.chunks:
            del index_cache.chunks[index_id]
        if index_id in index_cache.order:
            index_cache.order.remove(index_id)
        gc.collect()
            
    if not deleted:
        return {"status": "not_found", "message": f"Index {index_id} not found on disk."}
        
    return {"status": "deleted", "files": deleted}

@app.post("/similarity")
def compute_similarity(data: SentencePair):
    emb1 = model.encode([data.text1])
    emb2 = model.encode([data.text2])
    emb1 = np.array(emb1).astype("float32")
    emb2 = np.array(emb2).astype("float32")
    faiss.normalize_L2(emb1)
    faiss.normalize_L2(emb2)
    similarity = np.dot(emb1[0], emb2[0])
    return {"similarity": float(similarity)}

@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "model": "all-MiniLM-L6-v2",
        "reranker_available": reranker is not None,
        "indices_loaded": len([f for f in os.listdir("index_store") if f.endswith(".index")]) 
                         if os.path.exists("index_store") else 0
    }

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)
