FROM node:22.23.4-bookworm-slim
WORKDIR /app
COPY . .
CMD ["npm", "run", "demo"]
