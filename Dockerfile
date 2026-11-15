FROM node:22.22.1-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build && npm test
CMD ["npm", "start"]
