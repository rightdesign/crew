/**
 * `@modelcontextprotocol/server-filesystem` ships no `.d.ts` at all (JS-only
 * package) — this covers the handful of `dist/lib.js` exports
 * `passenger-mcp.ts` reuses, typed against their actual behavior rather than
 * left as implicit `any`.
 */
declare module '@modelcontextprotocol/server-filesystem/dist/lib.js' {
  export function setAllowedDirectories(directories: string[]): void;
  export function getAllowedDirectories(): string[];
  export function formatSize(bytes: number): string;

  export interface FileStats {
    size: number;
    created: Date;
    modified: Date;
    accessed: Date;
    isDirectory: boolean;
    isFile: boolean;
    permissions: string;
  }

  export function validatePath(requestedPath: string): Promise<string>;
  export function getFileStats(filePath: string): Promise<FileStats>;
  export function readFileContent(filePath: string, encoding?: string): Promise<string>;

  export interface SearchOptions {
    excludePatterns?: string[];
  }

  export function searchFilesWithValidation(
    rootPath: string,
    pattern: string,
    allowedDirectories: string[],
    options?: SearchOptions,
  ): Promise<string[]>;
}
