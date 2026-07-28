import fs from 'fs';

export function getFileMaybeYarnWorkspace(filePath: string): string {
  if (fs.existsSync(filePath)) {
    return filePath;
  } else {
    const cwd = process.cwd();
    const cwdFile = `${cwd}/${filePath}`;
    if (fs.existsSync(cwdFile)) {
      return cwdFile;
    } else {
      // if running from yarn workspace, check the workspace root
      const workspacePath = `${cwd}/../${filePath}`;
      if (fs.existsSync(workspacePath)) {
        return workspacePath;
      }
    }
    throw new FileNotFound(filePath);
  }
}

export class FileNotFound extends Error {
  constructor(filePath: string) {
    super(`File not found: ${filePath}`);
  }
}
