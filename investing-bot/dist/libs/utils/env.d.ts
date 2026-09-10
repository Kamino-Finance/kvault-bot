import { Address } from '@solana/kit';
export declare const getEnvOrThrow: (envVarName: string) => string;
export declare const getEnv: (envVarName: string) => string | undefined;
export declare const getEnvOrDefault: (envVarName: string, defaultValue: string) => string;
export declare const getEnvOrDefaultBool: (envVarName: string, defaultValue: boolean) => boolean;
export declare const getEnvOrDefaultNum: (envVarName: string, defaultValue: number) => number;
export declare const getEnvOrDefaultKey: (envVarName: string, defaultValue: string | Address) => Address;
export declare function getEnvOrDefaultJson<T>(envVarName: string, defaultValue: T): T;
export declare const getEnvOrThrowInProduction: (envVarName: string, defaultValue: string) => string;
/**
 * Returns a map (of key suffix => value) with all environment variables having key of the given prefix.
 */
export declare function getAllEnvsByPrefix(keyPrefix: string): Map<string, string>;
/**
 * Returns the given enum's value corresponding to the given string, or throws an error if no such value exists.
 *
 * Note: in TypeScript, the `E` cannot be derived from the type parameter, and thus must be passed as an argument, e.g.
 * `const value: FeePercentileSupport = parseValidEnum(FeePercentileSupport, 'TritonStyle');`.
 */
export declare function parseValidEnum<E extends Record<string, string>>(stringEnumType: E, enumString: string): E[keyof E];
//# sourceMappingURL=env.d.ts.map