# app/Dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY . .
RUN npx prisma generate

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app .
EXPOSE 3000
# Las migraciones no corren aquí: las aplica el servicio `migraciones` de
# docker-compose.yml con el dueño de la base, que la app no conoce.
CMD ["node", "src/server.js"]
