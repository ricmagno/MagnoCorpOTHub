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
import { startWorker, getEmbeddingQueue } from './workers/embedding-queue';
import { startWindowWorker, getWindowQueue } from './workers/window-embedding-queue';
import { createEmbeddingRouter } from './routes/embedding-routes';
import { createTeveRouter } from './routes/teve-compatibility';
import { createTeveSearchRouter } from './routes/teve-search';
import { createAdminDashboardRouter } from './routes/admin-dashboard';
import { typeDefs } from './graphql/schema';
import { makeResolvers } from './graphql/resolvers';

const logger = pino();

/** Dev entry point: API + worker in one process. Production splits api.ts / worker.ts. */
async function main() {
  const db = new Pool({ connectionString: config.database.url, max: 20 });

  const embedder = new ScreenshotEmbedder(db);
  await embedder.initialize();

  const capture = new ScreenshotCaptureService(db);
  const engine = new TeveEngine();
  const windows = new WindowEmbeddingService(db);
  const anomalyEmbeddings = new AnomalyEmbeddingService(db);

  startWorker(db, embedder);
  startWindowWorker(db);

  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/historian', createEmbeddingRouter(db, embedder, capture));
  app.use('/api', createTeveRouter(db));
  app.use('/api', createTeveSearchRouter(db, engine, windows, anomalyEmbeddings));
  app.use('/api', createAdminDashboardRouter(db));

  const apollo = new ApolloServer({
    schema: makeExecutableSchema({
      typeDefs,
      resolvers: makeResolvers(db, embedder, { engine, windows, anomalyEmbeddings }),
    }),
  });
  await apollo.start();
  app.use('/graphql', expressMiddleware(apollo));

  app.listen(config.server.port, () => logger.info(`historian on :${config.server.port}`));

  process.on('SIGTERM', async () => {
    await getEmbeddingQueue().close();
    await getWindowQueue().close();
    await capture.shutdown();
    await db.end();
    process.exit(0);
  });
}

main().catch(e => { logger.error(e); process.exit(1); });
