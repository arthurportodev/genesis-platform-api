import { registerAs } from '@nestjs/config';

export interface DatabaseConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}

export default registerAs('database', (): DatabaseConfig => ({
  host: process.env.DATABASE_HOST as string,
  port: Number(process.env.DATABASE_PORT ?? 5432),
  name: process.env.DATABASE_NAME as string,
  user: process.env.DATABASE_USER as string,
  password: process.env.DATABASE_PASSWORD as string,
}));
