FROM node:20-alpine AS build

WORKDIR /app

# Install build deps for better-sqlite3 (native module).
RUN apk add --no-cache python3 make g++ tzdata

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev


FROM node:20-alpine AS runtime

WORKDIR /app

# tzdata for IANA timezone support in croner.
RUN apk add --no-cache tzdata

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Bot writes its SQLite DB into ./data; mount as a volume in compose.
RUN mkdir -p data

CMD ["node", "dist/index.js"]
