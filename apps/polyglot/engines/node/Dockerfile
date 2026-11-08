FROM node:24-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY main.js ./
USER node
ENTRYPOINT ["node", "main.js"]
