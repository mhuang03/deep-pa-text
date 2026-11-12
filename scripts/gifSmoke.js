import { loadConfig } from '../src/config.js';
import { loadEnvIfPresent } from '../src/config/env.js';
import { assertRequired } from '../src/config/requirements.js';
import { isConfigError } from '../src/config/errors.js';
import { buildGifResolver } from '../src/container.js';
import { createVendor } from '../src/vendor.js';

const SAMPLE_TEXT = 'hahaha <gif! funny cat> <gif! that me yeah>';
const UNRESOLVED_MARKER = '<INSERT GIF:';

try {
  loadEnvIfPresent();
  const config = loadConfig(process.env);
  assertRequired(config, process.env, 'gif-smoke');
  const resolver = buildGifResolver({ config, vendor: createVendor() });
  const { content } = await resolver.resolve(SAMPLE_TEXT);
  console.log(content);
  if (content.includes(UNRESOLVED_MARKER)) {
    console.error('At least one GIF token did not resolve; see the engine warnings above.');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(isConfigError(error) ? error.message : `GIF smoke test failed: ${error.message}`);
  process.exitCode = 1;
}
