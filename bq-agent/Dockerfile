# Use an official Node.js runtime as a parent image
FROM node:20

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies using a clean install for production
RUN npm ci

# Copy the rest of your application code
COPY . .

# Your app binds to a port, default is 8080
EXPOSE 8080

# Define the command to run your app
CMD ["node", "index.js"]