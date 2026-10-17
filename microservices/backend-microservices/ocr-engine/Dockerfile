FROM python:3.12-slim

WORKDIR /app

# /app is the working directory; make it the Python root so that both
# service modules and the volume-mounted `shared/` package are importable.
ENV PYTHONPATH=/app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8004", "--reload"]
