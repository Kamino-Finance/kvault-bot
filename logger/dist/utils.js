export const getEnvOrDefault = (envVarName, defaultValue) => {
    if (envVarName in process.env) {
        return process.env[envVarName];
    }
    return defaultValue;
};
//# sourceMappingURL=utils.js.map