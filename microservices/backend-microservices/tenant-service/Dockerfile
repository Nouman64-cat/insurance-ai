FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# --workers 1 is REQUIRED: the renewal scheduler (renewal_scheduler.py) uses
# an asyncio task inside the uvicorn process. With multiple workers each
# process spawns its own scheduler, causing duplicate RenewalTransactions and
# concurrent state-machine races. A pg_try_advisory_lock guard inside the
# scheduler provides a second line of defence, but single-worker is the
# primary architectural constraint for the renewal batch engine.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--reload", "--workers", "1"]
