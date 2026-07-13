/**
 * Runs at Docker build time only (see Dockerfile.historian) to download the CLIP models
 * into a fixed cache dir baked into the images, so pods never need runtime internet
 * egress — required for air-gapped plant-network deployments.
 *
 * Downloads BOTH halves of CLIP:
 *  - vision model (image-feature-extraction pipeline) — used by the embedding worker
 *  - text model (tokenizer + CLIPTextModelWithProjection) — used by the API for /teve/search
 */
import config from '../../src/historian/config';

async function main() {
  const { pipeline, AutoTokenizer, CLIPTextModelWithProjection, env } = await import('@xenova/transformers');
  env.cacheDir = config.embedding.cacheDir;
  env.allowRemoteModels = true; // build machine has internet; runtime pods will not

  console.log(`Downloading ${config.embedding.model} (vision) into ${config.embedding.cacheDir} ...`);
  await pipeline('image-feature-extraction', config.embedding.model);

  console.log(`Downloading ${config.embedding.model} (text) into ${config.embedding.cacheDir} ...`);
  await AutoTokenizer.from_pretrained(config.embedding.model);
  await CLIPTextModelWithProjection.from_pretrained(config.embedding.model);

  console.log('Models cached.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
