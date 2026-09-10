/**
 * A trigger could not produce a trustworthy safety score. The caller must not interpret this as
 * either safe or dangerous: abort the whole danger pass so the allocation loop performs no rebalance.
 */
export class DangerTriggerUnavailableError extends Error {
    constructor(triggerName, reserveAddress, cause) {
        super(`[danger-detection] ${triggerName} could not assess reserve ${reserveAddress}: ${cause}`, { cause });
        this.name = 'DangerTriggerUnavailableError';
    }
}
/**
 * Risk appetite presets that map to safety thresholds.
 * When a reserve's combined safety drops below the threshold, emergency deinvest fires.
 */
export var RiskAppetiteMode;
(function (RiskAppetiteMode) {
    RiskAppetiteMode["PARANOID"] = "PARANOID";
    RiskAppetiteMode["SENSIBLE"] = "SENSIBLE";
    RiskAppetiteMode["YOLO"] = "YOLO";
})(RiskAppetiteMode || (RiskAppetiteMode = {}));
export const RISK_APPETITE_THRESHOLDS = {
    [RiskAppetiteMode.PARANOID]: 0.5,
    [RiskAppetiteMode.SENSIBLE]: 0.3,
    [RiskAppetiteMode.YOLO]: 0.1,
};
//# sourceMappingURL=dangerTypes.js.map