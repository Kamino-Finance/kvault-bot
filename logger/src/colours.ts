function colouredString(code: string, msg: string) {
  if (process.env.NODE_ENV !== 'production') {
    return `\x1b${code}${msg}\x1b[0m`;
  }
  return msg;
}

export function magenta(msg: string) {
  return colouredString('[35m', msg);
}
