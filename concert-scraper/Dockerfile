FROM python:3.12-slim

WORKDIR /app

# Install system dependencies for Playwright
RUN apt-get update && apt-get install -y \
  curl \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
  && playwright install --with-deps chromium

COPY . .

CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "5000"]
