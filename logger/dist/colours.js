function colouredString(code, msg) {
    if (process.env.NODE_ENV !== 'production') {
        return `\x1b${code}${msg}\x1b[0m`;
    }
    return msg;
}
export function red(msg) {
    return colouredString('[31m', msg);
}
export function green(msg) {
    return colouredString('[32m', msg);
}
export function magenta(msg) {
    return colouredString('[35m', msg);
}
export function yellow(msg) {
    return colouredString('[33m', msg);
}
export function blue(msg) {
    return colouredString('[34m', msg);
}
export function cyan(msg) {
    return colouredString('[36m', msg);
}
export function lightRed(msg) {
    return colouredString('[91m', msg);
}
export function lightGreen(msg) {
    return colouredString('[92m', msg);
}
export function lightBlue(msg) {
    return colouredString('[94m', msg);
}
export function lightMagenta(msg) {
    return colouredString('[95m', msg);
}
export function lightCyan(msg) {
    return colouredString('[96m', msg);
}
export function lightYellow(msg) {
    return colouredString('[93m', msg);
}
export function lightWhite(msg) {
    return colouredString('[97m', msg);
}
export function darkGray(msg) {
    return colouredString('[90m', msg);
}
export function lightGray(msg) {
    return colouredString('[37m', msg);
}
//# sourceMappingURL=colours.js.map