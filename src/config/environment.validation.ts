import Joi from 'joi';

export const environmentValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  APP_NAME: Joi.string().trim().required(),
  APP_VERSION: Joi.string().trim().required(),
  DATABASE_HOST: Joi.string().trim().required(),
  DATABASE_PORT: Joi.number().port().default(5432),
  DATABASE_NAME: Joi.string().trim().required(),
  DATABASE_USER: Joi.string().trim().required(),
  DATABASE_PASSWORD: Joi.string().min(1).required(),
  FRONTEND_URL: Joi.string().uri().required(),
  JWT_ACCESS_SECRET: Joi.string()
    .min(32)
    .invalid('replace-with-a-long-random-secret')
    .required(),
  JWT_ACCESS_EXPIRES_IN: Joi.string()
    .pattern(/^\d+[smhd]$/)
    .default('15m'),
  REFRESH_TOKEN_EXPIRES_IN_DAYS: Joi.number()
    .integer()
    .min(1)
    .max(365)
    .default(30),
  REFRESH_TOKEN_PEPPER: Joi.string()
    .min(32)
    .invalid('replace-with-a-long-random-secret')
    .required(),
  INITIAL_OWNER_PASSWORD: Joi.string()
    .min(10)
    .max(128)
    .invalid('change-me-locally')
    .optional(),
  AUTH_LOGIN_MAX_ATTEMPTS: Joi.number().integer().min(1).max(100).default(5),
  AUTH_LOGIN_WINDOW_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(86_400)
    .default(900),
});
