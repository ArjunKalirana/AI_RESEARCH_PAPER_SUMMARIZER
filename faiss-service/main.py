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

# Cross-encoder: loaded ONCE at startup for reranking.
reranker = None
try:
    reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
    logger.info("[startup] CrossEncoder loaded successfully")
except Exception as e:
    logger.warning(
        "[startup] CrossEncoder failed to load — reranking disabled, "
        "falling back to basic FAISS search. Reason: %s", e
    )

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
    indices = []
    if os.path.exists("index_store"):
        indices = [f.replace(".index", "") for f in os.listdir("index_store") if f.endswith(".index")]
    return {
        "status": "ok",
        "loaded_indices": indices,
        "total_loaded": len(indices)
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
    if reranker is None:
        return {"error": "reranker_unavailable", "results": []}

    # ── 1. Use Cache ──────────────────────────────────────────────────────────
    index, chunks_store = index_cache.get(data.index_id)
    if not index or not chunks_store:
        return {"results": []}

    row_to_text = {entry["row"]: entry["text"] for entry in chunks_store}
    row_to_chunk_index = {entry["row"]: entry["chunkIndex"] for entry in chunks_store}

    # ── 3. FAISS retrieval ────────────────────────────────────────────────────
    query_embedding = model.encode([data.query])
    query_embedding = np.array(query_embedding).astype("float32")
    faiss.normalize_L2(query_embedding)

    fetch_k = min(data.fetch_k, index.ntotal)
    if fetch_k == 0:
        return {"results": []}

    D, I = index.search(query_embedding, fetch_k)
    faiss_distances = D[0].tolist()
    faiss_indices   = I[0].tolist()

    # ── 4. Build candidates ───────────────────────────────────────────────────
    candidates = []
    for row, faiss_score in zip(faiss_indices, faiss_distances):
        if row == -1:
            continue
        text = row_to_text.get(row)
        if text is None:
            continue
        candidates.append({
            "row":         row,
            "chunkIndex":  row_to_chunk_index.get(row, row),
            "text":        text,
            "faiss_score": faiss_score,
        })

    if not candidates:
        return {"results": []}

    # ── 5. Cross-encoder scoring ──────────────────────────────────────────────
    pairs = [[data.query, c["text"]] for c in candidates]
    rerank_scores = reranker.predict(pairs)

    for candidate, score in zip(candidates, rerank_scores.tolist()):
        candidate["rerank_score"] = score

    # ── 6. Sort and return top k ──────────────────────────────────────────────
    candidates.sort(key=lambda c: c["rerank_score"], reverse=True)
    top_k = candidates[: data.k]

    results = [
        {
            "row":          c["row"],
            "chunkIndex":   c["chunkIndex"],
            "text":         c["text"],
            "faiss_score":  c["faiss_score"],
            "rerank_score": c["rerank_score"],
        }
        for c in top_k
    ]

    return {"results": results}


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

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)
