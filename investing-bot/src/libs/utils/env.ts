import { address, Address } from '@solana/kit';

export const getEnvOrThrow = (envVarName: string) => {
  if (envVarName in process.env) {
    return process.env[envVarName] as string;
  }
  throw Error(`${envVarName} environment variable does not exist`);
};

export const getEnv = (envVarName: string): string | undefined => {
  if (envVarName in process.env) {
    return process.env[envVarName] as string;
  }
  return undefined;
};

export const getEnvOrDefault = (envVarName: string, defaultValue: string): string => {
  if (envVarName in process.env) {
    return process.env[envVarName] as string;
  }
  return defaultValue;
};

export const getEnvOrDefaultBool = (envVarName: string, defaultValue: boolean): boolean => {
  if (!(envVarName in process.env)) {
    return defaultValue;
  }
  const rawValue = process.env[envVarName] as string;
  if (rawValue === 'true') {
    return true;
  }
  if (rawValue === 'false') {
    return false;
  }
  throw new Error(`${envVarName} must be "true" or "false", received "${rawValue}"`);
};

export const getEnvOrDefaultNum = (envVarName: string, defaultValue: number): number => {
  if (envVarName in process.env) {
    const rawValue = process.env[envVarName] as string;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new Error(`${envVarName} must be a finite number, received "${rawValue}"`);
    }
    return value;
  }
  return defaultValue;
};

export const getEnvOrDefaultKey = (envVarName: string, defaultValue: string | Address): Address => {
  if (envVarName in process.env) {
    return address(process.env[envVarName] as string);
  }
  return address(defaultValue);
};

export function getEnvOrDefaultJson<T>(envVarName: string, defaultValue: T): T {
  if (envVarName in process.env) {
    return JSON.parse(process.env[envVarName]!) as T;
  }
  return defaultValue;
}

export const getEnvOrThrowInProduction = (envVarName: string, defaultValue: string) => {
  if (envVarName in process.env) {
    return process.env[envVarName] as string;
  }
  if (process.env.NODE_ENV === 'production') {
    throw Error(`${envVarName} environment variable does not exist`);
  }
  return defaultValue;
};

/**
 * Returns a map (of key suffix => value) with all environment variables having key of the given prefix.
 */
export function getAllEnvsByPrefix(keyPrefix: string): Map<string, string> {
  return new Map(
    Object.keys(process.env)
      .filter((key) => key.startsWith(keyPrefix))
      .map((matchingKey) => [matchingKey.substring(keyPrefix.length), process.env[matchingKey]!])
  );
}

/**
 * Returns the given enum's value corresponding to the given string, or throws an error if no such value exists.
 *
 * Note: in TypeScript, the `E` cannot be derived from the type parameter, and thus must be passed as an argument, e.g.
 * `const value: FeePercentileSupport = parseValidEnum(FeePercentileSupport, 'TritonStyle');`.
 */
export function parseValidEnum<E extends Record<string, string>>(stringEnumType: E, enumString: string): E[keyof E] {
  const validValues = Object.values(stringEnumType) as Array<E[keyof E]>;
  const validValue = validValues.find((value) => value === enumString);
  if (validValue === undefined) {
    throw new Error(`Invalid enum value ${enumString}. Must be one of: ${validValues.join(', ')}`);
  }
  return validValue;
}
