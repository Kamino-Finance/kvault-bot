export const getEnv = (envVarName: string): string | undefined => {
  if (envVarName in process.env) {
    return process.env[envVarName] as string;
  }
  return undefined;
};

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
