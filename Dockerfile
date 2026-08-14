FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source files
COPY . .

# Expose Vite frontend and Express backend ports
EXPOSE 5173 8787

# Set host to 0.0.0.0 so Vite is accessible outside the container
ENV HOST=0.0.0.0

# Start both server and frontend
CMD ["npm", "run", "dev:all"]
