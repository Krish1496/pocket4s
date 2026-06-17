FROM python:3.12-slim

WORKDIR /app

# Install deps first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Platforms inject $PORT; default to 8021 for local `docker run`.
ENV PORT=8021
EXPOSE 8021

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --ws-ping-interval 25 --ws-ping-timeout 60 --timeout-keep-alive 75"]
