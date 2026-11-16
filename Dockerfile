FROM node:22.22.1-bookworm-slim
WORKDIR /app
COPY . .
CMD ["npm", "run", "demo"]
