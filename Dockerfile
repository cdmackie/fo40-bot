FROM python:3.12-slim

WORKDIR /app

# tzdata so zoneinfo works inside the container
RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bot.py ./
COPY core/ ./core/
COPY cogs/ ./cogs/

CMD ["python", "-u", "bot.py"]
