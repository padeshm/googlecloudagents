# Use a lightweight Node image
FROM node:20-slim

# 1. Install System Dependencies required for Gcloud SDK (Python, Curl)
RUN apt-get update && apt-get install -y \
    python3 \
    curl \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Google Cloud CLI, bq component, and kubectl
RUN echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] http://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list && \
    curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | apt-key --keyring /usr/share/keyrings/cloud.google.gpg add - && \
    apt-get update && apt-get install -y google-cloud-cli google-cloud-sdk-bigquery kubectl

# 3. Application Setup
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript to JavaScript
RUN npm run build

# 4. Start the Server
# Cloud Run injects the PORT environment variable
CMD ["npm", "start"]
