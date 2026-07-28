import axios from 'axios';
import { logger } from 'kvaults-investing-bot-logger';
import { DEFAULT_MEDIAN_SLOT_DURATION_IN_MS } from '../libs/utils/consts.js';
import { EXTERNAL_REQUEST_TIMEOUT_MS } from './timeout.js';

export async function getMedianSlotDurationInMsFromLastEpochsOrDefault(
  defaultSlotDurationMS: number = DEFAULT_MEDIAN_SLOT_DURATION_IN_MS
) {
  try {
    const response = await axios.get<{ recentSlotDurationInMs: number }>('https://api.kamino.finance/slots/duration', {
      timeout: EXTERNAL_REQUEST_TIMEOUT_MS,
    });
    return response.data.recentSlotDurationInMs;
  } catch (error) {
    logger.error('Error fetching median slot duration in milliseconds from the last epochs', error);
    return defaultSlotDurationMS;
  }
}
