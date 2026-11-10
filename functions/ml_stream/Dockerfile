FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PORT=8080
WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY main.py .
# Eventarc（CloudEvent）の受け手。1 イベント = BigQuery への 1 行の追記
CMD ["sh", "-c", "functions-framework --target=on_firestore --signature-type=cloudevent --port ${PORT}"]
