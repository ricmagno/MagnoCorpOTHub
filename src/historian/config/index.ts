import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  database: {
    url: process.env.HISTORIAN_DATABASE_URL ??
      'postgresql://historian:historian_pwd@localhost:5432/historian_db',
  },
  s3: {
    endpoint: process.env.HISTORIAN_S3_ENDPOINT ?? 'http://localhost:9000',
    accessKey: process.env.HISTORIAN_S3_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.HISTORIAN_S3_SECRET_KEY ?? 'minioadmin',
    bucket: process.env.HISTORIAN_S3_BUCKET ?? 'historian-data',
    region: process.env.HISTORIAN_S3_REGION ?? 'us-east-1',
  },
  redis: { url: process.env.HISTORIAN_REDIS_URL ?? 'redis://localhost:6379' },
  embedding: {
    // Xenova model id; downloaded automatically on first run unless allowRemoteModels is false
    model: process.env.HISTORIAN_EMBEDDING_MODEL ?? 'Xenova/clip-vit-base-patch16',
    dimension: 512, // CLIP-ViT-Base projected image embedding size
    // Baked into the worker image at build time (see Dockerfile.historian) so plant-network
    // deployments with no internet egress can still run the embedding worker.
    cacheDir: process.env.HISTORIAN_MODEL_CACHE_DIR ?? './.model-cache',
    allowRemoteModels: process.env.HISTORIAN_ALLOW_REMOTE_MODELS !== 'false',
  },
  server: { port: parseInt(process.env.HISTORIAN_PORT ?? '3100', 10) },
  worker: {
    concurrency: parseInt(process.env.HISTORIAN_WORKER_CONCURRENCY ?? '4', 10),
    healthPort: parseInt(process.env.HISTORIAN_WORKER_HEALTH_PORT ?? '3101', 10),
  },
  teve: {
    // Time-series window embeddings: windows are epoch-aligned slices of this length.
    tsWindowMinutes: parseInt(process.env.HISTORIAN_TS_WINDOW_MINUTES ?? '60', 10),
    // How often the worker embeds the last completed window for every active tag.
    tsEmbedEveryMinutes: parseInt(process.env.HISTORIAN_TS_EMBED_EVERY_MINUTES ?? '15', 10),
  },
};
export default config;
