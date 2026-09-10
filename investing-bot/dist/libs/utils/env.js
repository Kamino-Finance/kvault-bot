import { address } from '@solana/kit';
export const getEnvOrThrow = (envVarName) => {
    if (envVarName in process.env) {
        return process.env[envVarName];
    }
    throw Error(`${envVarName} environment variable does not exist`);
};
export const getEnv = (envVarName) => {
    if (envVarName in process.env) {
        return process.env[envVarName];
    }
    return undefined;
};
export const getEnvOrDefault = (envVarName, defaultValue) => {
    if (envVarName in process.env) {
        return process.env[envVarName];
    }
    return defaultValue;
};
export const getEnvOrDefaultBool = (envVarName, defaultValue) => {
    if (!(envVarName in process.env)) {
        return defaultValue;
    }
    const rawValue = process.env[envVarName];
    if (rawValue === 'true') {
        return true;
    }
    if (rawValue === 'false') {
        return false;
    }
    throw new Error(`${envVarName} must be "true" or "false", received "${rawValue}"`);
};
export const getEnvOrDefaultNum = (envVarName, defaultValue) => {
    if (envVarName in process.env) {
        const rawValue = process.env[envVarName];
        const value = Number(rawValue);
        if (!Number.isFinite(value)) {
            throw new Error(`${envVarName} must be a finite number, received "${rawValue}"`);
        }
        return value;
    }
    return defaultValue;
};
export const getEnvOrDefaultKey = (envVarName, defaultValue) => {
    if (envVarName in process.env) {
        return address(process.env[envVarName]);
    }
    return address(defaultValue);
};
export function getEnvOrDefaultJson(envVarName, defaultValue) {
    if (envVarName in process.env) {
        return JSON.parse(process.env[envVarName]);
    }
    return defaultValue;
}
export const getEnvOrThrowInProduction = (envVarName, defaultValue) => {
    if (envVarName in process.env) {
        return process.env[envVarName];
    }
    if (process.env.NODE_ENV === 'production') {
        throw Error(`${envVarName} environment variable does not exist`);
    }
    return defaultValue;
};
/**
 * Returns a map (of key suffix => value) with all environment variables having key of the given prefix.
 */
export function getAllEnvsByPrefix(keyPrefix) {
    return new Map(Object.keys(process.env)
        .filter((key) => key.startsWith(keyPrefix))
        .map((matchingKey) => [matchingKey.substring(keyPrefix.length), process.env[matchingKey]]));
}
/**
 * Returns the given enum's value corresponding to the given string, or throws an error if no such value exists.
 *
 * Note: in TypeScript, the `E` cannot be derived from the type parameter, and thus must be passed as an argument, e.g.
 * `const value: FeePercentileSupport = parseValidEnum(FeePercentileSupport, 'TritonStyle');`.
 */
export function parseValidEnum(stringEnumType, enumString) {
    const validValues = Object.values(stringEnumType);
    const validValue = validValues.find((value) => value === enumString);
    if (validValue === undefined) {
        throw new Error(`Invalid enum value ${enumString}. Must be one of: ${validValues.join(', ')}`);
    }
    return validValue;
}
//# sourceMappingURL=env.js.map