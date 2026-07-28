import axios from 'axios';
import { logger } from 'kvaults-investing-bot-logger';

const API_URL = 'https://api.kamino.finance';
const COLLECT_ENDPOINT = '/replay-samples/collect';
const SERIALIZED_TRANSACTION_ENCODING: BufferEncoding = 'base64';

/**
 * Report a transaction sample to the Kamino API
 * @param serializedTransaction - The serialized transaction buffer
 * @param description - The description of the transaction
 */
export async function reportTransactionSample(serializedTransaction: Buffer, description?: string): Promise<void> {
  try {
    await axios.post(API_URL + COLLECT_ENDPOINT, {
      description,
      serializedTransaction: {
        encoding: SERIALIZED_TRANSACTION_ENCODING,
        value: serializedTransaction.toString(SERIALIZED_TRANSACTION_ENCODING),
      },
    });
    logger.info(`Transaction sample reported for ${description}`);
  } catch (err) {
    // we deliberately do not want the sample-reporting errors to affect sending the tx - that's why we are swallowing it here
    logger.warn('Error reporting transaction sample:', err);
  }
}
