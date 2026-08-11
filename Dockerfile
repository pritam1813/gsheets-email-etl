# Use the official Bun image
FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install dependencies separately to leverage Docker cache
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the rest of the application code
COPY . .

# Default command to run the worker
CMD ["bun", "run", "worker.ts"]
