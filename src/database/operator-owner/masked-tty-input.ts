import { OperatorOwnerError } from './operator-owner.model';

export interface SecretBufferReader {
  read(prompt: string): Promise<Buffer>;
}

export class MaskedTtyInput implements SecretBufferReader {
  constructor(
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {}

  read(prompt: string): Promise<Buffer> {
    if (
      !this.input.isTTY ||
      !this.output.isTTY ||
      typeof this.input.setRawMode !== 'function'
    ) {
      throw new OperatorOwnerError(
        'SECURE_TTY_REQUIRED',
        'Interactive secret input requires a secure TTY.',
      );
    }

    this.output.write(`${prompt} (input hidden): `);
    return new Promise<Buffer>((resolve, reject) => {
      const bytes: number[] = [];
      const previousRawMode = this.input.isRaw;

      const cleanup = (): void => {
        this.input.off('data', onData);
        this.input.setRawMode(previousRawMode);
        this.input.pause();
        this.output.write('\n');
      };
      const finish = (): void => {
        const result = Buffer.from(bytes);
        bytes.fill(0);
        cleanup();
        resolve(result);
      };
      const cancel = (): void => {
        bytes.fill(0);
        cleanup();
        reject(
          new OperatorOwnerError(
            'PASSWORD_INPUT_CANCELLED',
            'Interactive secret input was cancelled.',
          ),
        );
      };
      const onData = (chunk: Buffer): void => {
        try {
          for (const byte of chunk) {
            if (byte === 0x03) {
              cancel();
              return;
            }
            if (byte === 0x0d || byte === 0x0a) {
              finish();
              return;
            }
            if (byte === 0x08 || byte === 0x7f) {
              removeLastUtf8CodePoint(bytes);
              continue;
            }
            if (byte >= 0x20) bytes.push(byte);
          }
        } finally {
          chunk.fill(0);
        }
      };

      this.input.setRawMode(true);
      this.input.resume();
      this.input.on('data', onData);
    });
  }
}

function removeLastUtf8CodePoint(bytes: number[]): void {
  if (bytes.length === 0) return;
  let removed = bytes.pop();
  while (
    removed !== undefined &&
    (Number(removed) & 0xc0) === 0x80 &&
    bytes.length > 0
  ) {
    removed = bytes.pop();
  }
}
