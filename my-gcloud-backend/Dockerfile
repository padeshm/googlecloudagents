# Use a lightweight Node image
FROM node:20-slim

# 1. Install System Dependencies & kubectl
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    python3 && \
    mkdir -p -m 755 /etc/apt/keyrings && \
    curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.30/deb/Release.key | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg && \
    echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.30/deb/ /' | tee /etc/apt/sources.list.d/kubernetes.list && \
    apt-get update && \
    apt-get install -y kubectl && \
    rm -rf /var/lib/apt/lists/*

# 2. Manually Install the Google Cloud SDK for full control
ENV GCLOUD_SDK_VERSION=468.0.0
ENV GCLOUD_SDK_URL="https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-${GCLOUD_SDK_VERSION}-linux-x86_64.tar.gz"

# Download, extract, install, and create symbolic links
RUN curl -O ${GCLOUD_SDK_URL} && \
    tar -xf google-cloud-cli-${GCLOUD_SDK_VERSION}-linux-x86_64.tar.gz && \
    rm google-cloud-cli-${GCLOUD_SDK_VERSION}-linux-x86_64.tar.gz && \
    ./google-cloud-sdk/install.sh --quiet --usage-reporting=false --path-update=true && \
    ln -s /google-cloud-sdk/bin/gcloud /usr/bin/gcloud && \
    ln -s /google-cloud-sdk/bin/bq /usr/bin/bq && \
    ln -s /google-cloud-sdk/bin/gsutil /usr/bin/gsutil

# Add gcloud to the PATH for all future sessions (good practice)
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

# 4. Start the Server with Diagnostics
# This will run our debug commands first, then start the server.
CMD echo "--- RUNNING DIAGNOSTICS ---" && \
    echo "1. Checking symbolic link..." && \
    ls -l /usr/bin/bq && \
    echo "2. Checking actual executable..." && \
    ls -l /google-cloud-sdk/bin/bq && \
    echo "3. Checking PATH variable..." && \
    echo $PATH && \
    echo "4. Testing bq command via absolute path..." && \
    /usr/bin/bq --version && \
    echo "--- DIAGNOSTICS COMPLETE, STARTING SERVER ---" && \
    npm start
