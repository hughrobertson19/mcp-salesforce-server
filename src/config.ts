import { z } from 'zod';

const EnvSchema = z.object({
  SF_CLIENT_ID: z.string().min(1, 'SF_CLIENT_ID is required'),
  SF_CLIENT_SECRET: z.string().min(1, 'SF_CLIENT_SECRET is required'),
  SF_LOGIN_URL: z.url(),
  SF_API_VERSION: z.string().default('61.0'),
  DATA_DIR: z.string().default('./data'),
  PROPOSAL_TTL_MINUTES: z.coerce.number().positive().default(15),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(): Config {
  try {
    process.loadEnvFile('.env');
  } catch {
    // .env is optional — CI or a parent shell may supply the vars directly.
  }
  return EnvSchema.parse(process.env);
}
