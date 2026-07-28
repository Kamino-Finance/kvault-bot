function colouredString(code: string, msg: string) {
  if (process.env.NODE_ENV !== 'production') {
    return `\x1b${code}${msg}\x1b[0m`;
  }
  return msg;
}

export function red(msg: string) {
  return colouredString('[31m', msg);
}

export function green(msg: string) {
  return colouredString('[32m', msg);
}

export function magenta(msg: string) {
  return colouredString('[35m', msg);
}

export function yellow(msg: string) {
  return colouredString('[33m', msg);
}

export function blue(msg: string): string {
  return colouredString('[34m', msg);
}

export function cyan(msg: string): string {
  return colouredString('[36m', msg);
}

export function lightRed(msg: string): string {
  return colouredString('[91m', msg);
}

export function lightGreen(msg: string): string {
  return colouredString('[92m', msg);
}

export function lightBlue(msg: string): string {
  return colouredString('[94m', msg);
}

export function lightMagenta(msg: string): string {
  return colouredString('[95m', msg);
}

export function lightCyan(msg: string): string {
  return colouredString('[96m', msg);
}

export function lightYellow(msg: string): string {
  return colouredString('[93m', msg);
}

export function lightWhite(msg: string): string {
  return colouredString('[97m', msg);
}

export function darkGray(msg: string): string {
  return colouredString('[90m', msg);
}

export function lightGray(msg: string): string {
  return colouredString('[37m', msg);
}
