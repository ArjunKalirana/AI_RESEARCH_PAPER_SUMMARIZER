FROM python:3.10-slim

WORKDIR /app

# Ensure we have build tools for dependencies like FAISS
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Install dependencies, ensuring uvicorn is installed to serve the FastAPI app
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir uvicorn

COPY main.py .

EXPOSE 8001

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
