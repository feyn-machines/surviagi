# Local MLflow tracking server for the scoring / progress-estimation experiment loop.
# Pinned so every run logs against the same server build. Fully local; no account.
FROM python:3.12-slim

# sqlalchemy is pinned because mlflow 2.18 imports FallbackAsyncAdaptedQueuePool,
# which sqlalchemy removed in 2.1; an unpinned install pulls 2.1 and the server
# exits on start with an ImportError.
RUN pip install --no-cache-dir mlflow==2.18.0 'sqlalchemy>=2.0,<2.1'

EXPOSE 5000
