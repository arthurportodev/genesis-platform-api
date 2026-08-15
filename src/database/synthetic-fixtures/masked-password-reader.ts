import { StringDecoder } from 'node:string_decoder';
import { SyntheticFixtureError } from './synthetic-fixture.model';

export interface SyntheticPasswordReader {
  read(role: 'ownerA' | 'memberA' | 'ownerB'): Promise<string>;
}

export class MaskedTtyPasswordReader implements SyntheticPasswordReader {
  constructor(
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {}

  read(role: 'ownerA' | 'memberA' | 'ownerB'): Promise<string> {
    if (
      !this.input.isTTY ||
      !this.output.isTTY ||
      typeof this.input.setRawMode !== 'function'
    ) {
      throw new SyntheticFixtureError(
        'SECURE_TTY_REQUIRED',
        'Interactive password input requires a secure TTY.',
      );
    }

    this.output.write(`Password for ${role} (input hidden): `);
    return new Promise<string>((resolve, reject) => {
      const decoder = new StringDecoder('utf8');
      const characters: string[] = [];
      const previousRawMode = this.input.isRaw;

      const cleanup = (): void => {
        this.input.off('data', onData);
        this.input.setRawMode(previousRawMode);
        this.input.pause();
        this.output.write('\n');
      };
      const finish = (): void => {
        cleanup();
        resolve(characters.join(''));
      };
      const cancel = (): void => {
        cleanup();
        reject(
          new SyntheticFixtureError(
            'PASSWORD_INPUT_CANCELLED',
            'Interactive password input was cancelled.',
          ),
        );
      };
      const onData = (chunk: Buffer): void => {
        for (const character of decoder.write(chunk)) {
          if (character === '\u0003') {
            cancel();
            return;
          }
          if (character === '\r' || character === '\n') {
            finish();
            return;
          }
          if (character === '\u007f' || character === '\b') {
            characters.pop();
            continue;
          }
          if (character >= ' ' && character !== '\u007f') {
            characters.push(character);
          }
        }
      };

      this.input.setRawMode(true);
      this.input.resume();
      this.input.on('data', onData);
    });
  }
}
