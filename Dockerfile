FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir fastapi uvicorn httpx websockets
COPY relay.py .
EXPOSE 8090
CMD ["uvicorn", "relay:app", "--host", "0.0.0.0", "--port", "8090"]
