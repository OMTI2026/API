import argon2 from 'argon2';

const opts = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB (OWASP mínimo recomendado)
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = (plain) => argon2.hash(plain, opts);

export const verifyPassword = (hash, plain) => argon2.verify(hash, plain);
