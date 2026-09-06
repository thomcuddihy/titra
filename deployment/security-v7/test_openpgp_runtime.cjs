'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const nodemailer = require('nodemailer')
const { openpgpEncrypt } = require('nodemailer-openpgp')
const openpgp = require('openpgp')

async function main() {
  const dependencyRoot = process.env.TITRA_EMAIL_RUNTIME_NODE_MODULES
  assert.ok(dependencyRoot, 'TITRA_EMAIL_RUNTIME_NODE_MODULES is required')
  const openpgpManifest = JSON.parse(readFileSync(join(
    dependencyRoot, 'openpgp', 'package.json',
  ), 'utf8'))
  const pluginManifest = JSON.parse(readFileSync(join(
    dependencyRoot, 'nodemailer-openpgp', 'package.json',
  ), 'utf8'))
  assert.equal(openpgpManifest.version, '6.3.1')
  assert.equal(pluginManifest.version, '2.2.1')

  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519',
    userIDs: [{ name: 'Titra v7 test', email: 'openpgp-test@example.invalid' }],
    format: 'armored',
  })
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows',
  })
  transport.use('stream', openpgpEncrypt())
  const expectedBody = 'Titra v7 OpenPGP compatibility probe'
  const result = await transport.sendMail({
    from: 'sender@example.invalid',
    to: 'recipient@example.invalid',
    subject: 'OpenPGP compatibility probe',
    text: expectedBody,
    encryptionKeys: [publicKey],
    shouldSign: false,
  })
  const rendered = result.message.toString('utf8')
  const armored = rendered.match(
    /-----BEGIN PGP MESSAGE-----[\s\S]+?-----END PGP MESSAGE-----/u,
  )?.[0]
  assert.ok(armored, 'Nodemailer plugin did not produce an armored PGP/MIME payload')

  const message = await openpgp.readMessage({ armoredMessage: armored })
  const decryptionKey = await openpgp.readPrivateKey({ armoredKey: privateKey })
  const decrypted = await openpgp.decrypt({ message, decryptionKeys: decryptionKey })
  assert.match(String(decrypted.data), new RegExp(expectedBody, 'u'))
  console.log('OpenPGP runtime compatibility passed: nodemailer-openpgp 2.2.1 + openpgp 6.3.1 encrypt/decrypt.')
}

const timeout = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('OpenPGP compatibility test timed out')), 60000)
  timer.unref()
})

Promise.race([main(), timeout]).catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
