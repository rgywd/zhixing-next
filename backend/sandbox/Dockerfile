FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils fonts-noto-cjk ripgrep && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /opt/zhixing/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /opt/zhixing/requirements.txt && playwright install --with-deps chromium && chmod -R a+rX /root/.cache/ms-playwright && mv /root/.cache/ms-playwright /opt/playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY skills /skills
COPY verify.py /opt/zhixing/verify.py
COPY browser.py /opt/zhixing/browser.py
WORKDIR /workspace
