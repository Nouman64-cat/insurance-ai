FROM python:3.12-slim AS model-assets
COPY scripts/install_trufor.py /tmp/install_trufor.py
RUN python /tmp/install_trufor.py /opt/trufor

FROM python:3.12-slim

WORKDIR /app
ENV PYTHONPATH=/app \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIXEL_PYTHON=/opt/pixel-venv/bin/python \
    TRUFOR_DIR=/opt/trufor \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY requirements-pixel.txt .
RUN python -m venv /opt/pixel-venv \
    && /opt/pixel-venv/bin/pip install --no-cache-dir torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cpu \
    && /opt/pixel-venv/bin/pip install --no-cache-dir -r requirements-pixel.txt
COPY --from=model-assets /opt/trufor /opt/trufor
RUN /opt/pixel-venv/bin/python -c "import torch, torchvision, timm, yacs; print('CPU pixel runtime ready:', torch.__version__)"

COPY requirements-storage.txt .
RUN pip install --no-cache-dir -r requirements-storage.txt

COPY . .
EXPOSE 8022
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8022"]
