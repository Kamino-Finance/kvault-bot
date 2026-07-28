export const getEnvOrDefault = (envVarName: string, defaultValue: string): string => {
  if (envVarName in process.env) {
    return process.env[envVarName] as string;
  }
  return defaultValue;
};
