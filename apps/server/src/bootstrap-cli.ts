import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createPool } from './db.js';
import { bootstrapAdmin } from './auth/bootstrap.js';

async function secretPrompt(prompt: string): Promise<string> {
  if (!stdin.isTTY) throw new Error('Interactive terminal required');
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (buffer: Buffer) => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') { finish(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && value.length < 129) value += char;
      }
    };
    stdin.on('data', onData);
  });
}

if (!stdin.isTTY || !stdout.isTTY || process.argv.length > 2) {
  console.error('Bootstrap requires a local interactive terminal and accepts no password arguments.');
  process.exitCode = 1;
} else {
  const url = process.env.BOOTSTRAP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Database configuration required');
  const pool = createPool(url);
  try {
    const rl = createInterface({ input: stdin, output: stdout });
    const email = await rl.question('Email pierwszego administratora: ');
    rl.close();
    const password = await secretPrompt('Hasło (12–128 znaków, niewidoczne): ');
    const confirmation = await secretPrompt('Powtórz hasło: ');
    if (password !== confirmation) throw new Error('Passwords differ');
    await bootstrapAdmin(pool, email, password);
    console.log('Administrator utworzony. Bootstrap został trwale zamknięty.');
  } catch {
    console.error('Bootstrap nie powiódł się. Sprawdź format email, długość/zgodność hasła, bazę i czy bootstrap nie został już wykonany.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
