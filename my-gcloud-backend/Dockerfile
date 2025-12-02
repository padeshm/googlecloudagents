# Use a lightweight Node image
FROM node:20-slim

# 1. Install System Dependencies required for Gcloud SDK
RUN apt-get update && apt-get install -y \
    python3 \
    curl \
    gnupg \
    # Install kubectl separately, as it's a standard k8s tool
    kubectl \
    && rm -rf /var/lib/apt/lists/*

# 2. Manually Install the Google Cloud SDK for full control

# Set the version and download URL
ENV GCLOUD_SDK_VERSION=468.0.0
ENV GCLOUD_SDK_URL="https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-${GCLOUD_SDK_VERSION}-linux-x86_64.tar.gz"

# Download, extract, and install
RUN curl -O ${GCLOUD_SDK_URL} && \
    tar -xf google-cloud-cli-${GCLOUD_SDK_VERSION}-linux-x86_64.tar.gz && \
    rm google-cloud-cli-${GCLOUD_SDK_VERSION}-linux-x86_64.tar.gz && \
    ./google-cloud-sdk/install.sh --quiet --usage-reporting=false --path-update=true && \
    # Ensure the PATH is correctly set for subsequent RUN commands
    ln -s /google-cloud-sdk/bin/gcloud /usr/bin/gcloud && \
    ln -s /google-cloud-sdk/bin/bq /usr/bin/bq && \
    ln -s /google-cloud-sdk/bin/gsutil /usr/bin/gsutil

# Add gcloud to the PATH for all future sessions
ENV PATH /google-cloud-sdk/bin:$PATH

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
CMD ["npm", "start"]
