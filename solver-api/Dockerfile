FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PORT=8080
WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY care ./care
# 1コンテナ1プロセス。CP-SAT のワーカー数は Cloud Run の vCPU に合わせて環境変数で指定する
CMD ["sh", "-c", "uvicorn care.server:app --host 0.0.0.0 --port ${PORT} --workers 1"]
