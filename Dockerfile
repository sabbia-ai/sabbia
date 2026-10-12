FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV SABBIA_DATA_DIR=/data
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD bun -e 'const r=await fetch("http://127.0.0.1:3000/healthz");process.exit(r.ok?0:1)'
CMD ["bun","run","src/index.ts"]
