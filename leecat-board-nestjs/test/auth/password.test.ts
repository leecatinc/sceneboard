import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppError } from '../../src/common/errors/app-error.js';
import { parseAuthCredentials, parsePasswordChangeRequest } from '../../src/auth/auth.dto.js';
import { PasswordService } from '../../src/auth/password.service.js';

test('owns exact email display/normalization and strict request fields', () => {
  assert.deepEqual(parseAuthCredentials({
    email: '  Dev.User+demo@SceneBoard.dev  ',
    password: 'correct horse battery staple',
  }), {
    email: 'Dev.User+demo@SceneBoard.dev',
    emailNormalized: 'dev.user+demo@sceneboard.dev',
    password: 'correct horse battery staple',
  });
  for (const email of [
    '.edge@sceneboard.dev',
    'edge.@sceneboard.dev',
    'two..dots@sceneboard.dev',
    'dev@localhost',
    'dev@-edge.sceneboard.dev',
    'dev@edge-.sceneboard.dev',
    '개발@sceneboard.dev',
  ]) assert.throws(() => parseAuthCredentials({ email, password: 'correct horse battery staple' }), AppError, email);
  assert.throws(() => parseAuthCredentials({
    email: 'dev@sceneboard.dev',
    password: 'correct horse battery staple',
    actor: 'caller-controlled',
  }), AppError);
});

test('enforces Unicode scalar and bcrypt byte boundaries without normalization', async () => {
  const service = new PasswordService(12, 500, 20);
  service.validate('abcdefghij');
  service.validate('😀'.repeat(10));
  assert.throws(() => service.validate('abcdefghi'), AppError);
  assert.throws(() => service.validate('a'.repeat(73)), AppError);
  assert.throws(() => service.validate(`abcdefghij\0`), AppError);

  const password = 'correct horse battery staple';
  const hash = await service.hash(password);
  assert.equal(await service.verify(password, hash), true);
  assert.equal(await service.verify('wrong password value', hash), false);
  assert.equal(service.needsRehash(hash), false);
});

test('password change accepts only exact current and replacement fields', () => {
  assert.deepEqual(parsePasswordChangeRequest({
    currentPassword: 'current-password',
    newPassword: 'replacement-password',
  }), {
    currentPassword: 'current-password',
    newPassword: 'replacement-password',
  });
  assert.throws(() => parsePasswordChangeRequest({
    currentPassword: '',
    newPassword: 'replacement-password',
  }), AppError);
  assert.throws(() => parsePasswordChangeRequest({
    currentPassword: 'current-password',
    newPassword: 'replacement-password',
    confirmPassword: 'replacement-password',
  }), AppError);
});
