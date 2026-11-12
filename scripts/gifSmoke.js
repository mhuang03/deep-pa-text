import { loadEnvFile } from 'node:process';
import { loadConfig } from '../src/config.js';
import { buildGifResolver } from '../src/container.js';
import { createVendor } from '../src/vendor.js';

const SAMPLE_TEXT = 'hahaha <gif! funny cat> <gif! that me yeah>';

loadEnvFile('.env');
const resolver = buildGifResolver({ config: loadConfig(process.env), vendor: createVendor() });
console.log(await resolver.resolve(SAMPLE_TEXT));
