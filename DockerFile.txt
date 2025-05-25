# Use Playwright's Ubuntu image with all browser deps preinstalled
FROM mcr.microsoft.com/playwright:v1.34.0-focal

# Set working directory
WORKDIR /usr/src/app

# Copy package manifest & install dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of your source code
COPY . .

# (Optional) expose ports, e.g. for a web app:
# EXPOSE 3000

# Default start command
CMD ["npm", "start"]
