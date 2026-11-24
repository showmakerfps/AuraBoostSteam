const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

const version = 'v1';
const algorithm = 'aes-256-gcm';
const ivLength = 12;
const tagLength = 16;

function decodePart(part) {
  const decoded = Buffer.from(part, 'base64url');
  if (decoded.toString('base64url') !== part) throw Error('Formato inválido.');
  return decoded;
}

function associatedData(context) {
  if (typeof context !== 'string' || !context) throw Error('Contexto de sesión inválido.');
  return Buffer.from(`auraboost-session:${version}:${context}`, 'utf8');
}

function createTokenCipher(base64Key) {
  const key = Buffer.from(typeof base64Key === 'string' ? base64Key : '', 'base64');
  if (key.length !== 32 || key.toString('base64') !== base64Key) {
    throw Error('SESSION_ENCRYPTION_KEY debe contener 32 bytes codificados en Base64.');
  }

  return {
    encrypt(value, context) {
      if (typeof value !== 'string') throw Error('Valor de sesión inválido.');
      const iv = randomBytes(ivLength);
      const cipher = createCipheriv(algorithm, key, iv, { authTagLength: tagLength });
      cipher.setAAD(associatedData(context));
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return [version, ...[iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url'))].join('.');
    },

    decrypt(value, context) {
      try {
        const parts = value.split('.');
        if (parts.length !== 4 || parts[0] !== version) throw Error('Versión inválida.');
        const [iv, tag, ciphertext] = parts.slice(1).map(decodePart);
        if (iv.length !== ivLength || tag.length !== tagLength) throw Error('Formato inválido.');
        const decipher = createDecipheriv(algorithm, key, iv, { authTagLength: tagLength });
        decipher.setAAD(associatedData(context));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        throw Error('No se pudo descifrar la sesión.');
      }
    }
  };
}

module.exports = { createTokenCipher };
