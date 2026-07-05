FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
# postgresql18-client: N1 DB 백업 pg_dump — 서버(PG18) 정합. alpine 에 18 패키지 없으면 base 이미지 업 필요 (Phase 2 EC2 대비 — Railway 는 nixpacks.toml)
RUN apk add --no-cache postgresql18-client
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
