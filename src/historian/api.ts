import express from 'express';
import { Pool } from 'pg';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { makeExecutableSchema } from '@graphql-tools/schema';
import pino from 'pino';
import config from './config';
import { ScreenshotEmbedder } from './services/screenshot-embedder';
import { ScreenshotCaptureService } from './services/screenshot-capture';
import { WindowEmbeddingService } from './services/window-embedding';
import { AnomalyEmbeddingService } from './services/anomaly-embedding';
import { TeveEngine } from './teve/engine';
import { createEmbeddingRouter } from './routes/embedding-routes';
import { createTeveRouter } from './routes/teve-compatibility';
import { createTeveSearchRouter } from './routes/teve-search';
import { typeDefs } from './graphql/schema';
import { makeResolvers } from './graphql/resolvers';

const logger = pino();

/**
 * Production API entry point. Deliberately does not call embedder.initialize() or
 * startWorker() — the CLIP model and Bull consumer live only in worker.ts, per a
 * separate Deployment, so API pods stay light and scale independently of embedding
 * throughput. findSimilar() only reads already-stored vectors via pgvector, so it
 * works fine on an uninitialized embedder; capture still needs Puppeteer/Chromium here
 * since screenshot capture is a synchronous part of the POST /screenshots request.
 */
async function main() {
  const db = new Pool({ connectionString: config.database.url, max: 20 });

  const embedder = new ScreenshotEmbedder(db);
  const capture = new ScreenshotCaptureService(db);
  // TEVE: the text extractor loads lazily on first /teve/search, so API pods that
  // never serve a search stay light; window/anomaly embeddings are pure TS (no model).
  const engine = new TeveEngine();
  const windows = new WindowEmbeddingService(db);
  const anomalyEmbeddings = new AnomalyEmbeddingService(db);

  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/historian', createEmbeddingRouter(db, embedder, capture));
  app.use('/api', createTeveRouter(db));
  app.use('/api', createTeveSearchRouter(db, engine, windows, anomalyEmbeddings));

  const apollo = new ApolloServer({
    schema: makeExecutableSchema({
      typeDefs,
      resolvers: makeResolvers(db, embedder, { engine, windows, anomalyEmbeddings }),
    }),
  });
  await apollo.start();
  app.use('/graphql', expressMiddleware(apollo));

  app.listen(config.server.port, () => logger.info(`historian-api on :${config.server.port}`));

  process.on('SIGTERM', async () => {
    await capture.shutdown();
    await db.end();
    process.exit(0);
  });
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
