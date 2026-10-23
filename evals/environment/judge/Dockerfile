# The judge service of the evaluation stack: DeepEval plus a small HTTP wrapper. Built on the backend image the stack already uses
# (same Python, FastAPI and httpx); DeepEval is installed here and nowhere else. The code is mounted at run time (see the compose file).
FROM insurance-ai-eval-backend
RUN pip install --no-cache-dir "deepeval==3.9.9"
ENV DEEPEVAL_TELEMETRY_OPT_OUT=YES ERROR_REPORTING=NO HOME=/tmp
WORKDIR /tmp
