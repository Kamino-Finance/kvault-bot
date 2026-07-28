let processShuttingDown = false;

export function isProcessShuttingDown(): boolean {
  return processShuttingDown;
}

export function markProcessShuttingDown(): void {
  processShuttingDown = true;
}
