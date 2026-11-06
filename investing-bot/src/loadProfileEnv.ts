import { config } from 'dotenv';
import { expand } from 'dotenv-expand';
import { SETTINGS } from './config/settings.js';

// index.ts imports this module first: modules such as the logger read their settings when they load, so the profile
// must be in the environment before any of them loads.

// always set timezone to UTC
process.env.TZ = 'Universal';

// Select and load the profile before reading any setting from it. Process-level PROFILE/CLUSTER
// choose the file; values inside the file configure the bot, including the health server.
const initialCluster = process.env.CLUSTER || SETTINGS.CLUSTER.default;
const initialProfile = process.env.PROFILE || initialCluster;
const envPath = `../.env.${initialProfile}`;
try {
  const envResult = config({ path: envPath });
  if (envResult.error) {
    console.log(`No .env file found at ${envPath}, using environment variables`);
  } else {
    expand(envResult);
    console.log(`Loaded .env file from ${envPath}`);
  }
} catch (error) {
  console.log(`Failed to load ${envPath}, using environment variables:`, error);
}
