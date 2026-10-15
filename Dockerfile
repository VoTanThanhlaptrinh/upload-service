FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# Cài toàn bộ deps (kể cả dev) để build TypeScript
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Chỉ cài deps runtime
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4000
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist

USER node
EXPOSE 4000

# /health không cần API key; Node 22 có sẵn fetch nên không cần cài curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
