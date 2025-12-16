# Use an official Node.js runtime as a parent image
FROM node:20

# Install the Google Cloud SDK, which includes bq
ENV GCLOUD_SDK_VERSION=468.0.0
ENV GCLOUD_SDK_URL="https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-${GCLOUD_SDK_VERSION}-linux-x86_64.tar.gz"

RUN apt-get update && apt-get install -y --no-install-recommends curl python3 && \
    curl -O ${GCLOUD_SDK_URL} && \
    tar -xf google-cloud-cli-${GCLOUD_SDK_VERSION}-linux-x86_64.tar.gz && \
    rm google-cloud-cli-${GCLOUD_SDK_VERSION}-linux-x86_64.tar.gz && \
    ./google-cloud-sdk/install.sh --quiet --usage-reporting=false --path-update=true && \
    ln -s /google-cloud-sdk/bin/gcloud /usr/bin/gcloud && \
    ln -s /google-cloud-sdk/bin/bq /usr/bin/bq

# Add gcloud to the PATH for all future sessions
ENV PATH /google-cloud-sdk/bin:$PATH

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies
RUN npm ci

# Copy the rest of your application code
COPY . .

# Your app binds to a port, default is 8080
EXPOSE 8080

# Define the command to run your app
CMD ["node", "index.js"]
