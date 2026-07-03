// Honor https://no-color.org (presence of NO_COLOR, any value) and skip ANSI when piped.
const useColor = process.stdout.isTTY === true && !('NO_COLOR' in process.env);

const ESC = String.fromCharCode(27);

function paint(code: number, text: string): string {
  return useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;
}

export const log = {
  info(message: string): void {
    console.log(`${paint(36, '[ship]')} ${message}`);
  },
  ok(message: string): void {
    console.log(`${paint(32, '[ ok ]')} ${message}`);
  },
  warn(message: string): void {
    console.warn(`${paint(33, '[warn]')} ${message}`);
  },
  fail(message: string): void {
    console.error(`${paint(31, '[fail]')} ${message}`);
  },
} as const;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
