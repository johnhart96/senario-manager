'use strict';

// All mail traffic goes through this module and is locked to the single
// configured scenario mail server:
//  - outbound: customer emails are submitted only to that server (no MX lookups)
//  - inbound: the listener only accepts SMTP connections from that server

const dns = require('dns').promises;
const net = require('net');
const nodemailer = require('nodemailer');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

const normIp = (ip) => String(ip || '').replace(/^::ffff:/i, '').toLowerCase();

function serverHost(mail) {
  const host = String(mail.host || '').trim();
  if (!host) throw new Error('No mail server configured (Settings → Mail server).');
  if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) {
    throw new Error(`Invalid mail server host "${host}". Use a bare hostname or IP address.`);
  }
  return host.replace(/^\[(.*)\]$/, '$1');
}

// ---------- outbound ----------

function createSmtp(mail) {
  const opts = {
    host: serverHost(mail),
    port: Number(mail.smtpPort) || 25,
    secure: mail.smtpSecurity === 'tls',
    ignoreTLS: mail.smtpSecurity === 'none',
    requireTLS: mail.smtpSecurity === 'starttls',
    tls: { rejectUnauthorized: !mail.allowSelfSigned },
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  };
  if (mail.smtpAuth && mail.username) opts.auth = { user: mail.username, pass: mail.password };
  return nodemailer.createTransport(opts);
}

async function sendMail(mail, message) {
  const transport = createSmtp(mail);
  try {
    return await transport.sendMail(message);
  } finally {
    transport.close();
  }
}

async function verifySmtp(mail) {
  const transport = createSmtp(mail);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

// ---------- inbound ----------

async function allowedSourceIps(mail, listener) {
  const host = serverHost(mail);
  const ips = new Set((listener.extraAllowedIps || []).map(normIp).filter(Boolean));
  if (net.isIP(host)) {
    ips.add(normIp(host));
  } else {
    const found = await dns.lookup(host, { all: true });
    for (const a of found) ips.add(normIp(a.address));
  }
  return ips;
}

function smtpError(code, message) {
  const err = new Error(message);
  err.responseCode = code;
  return err;
}

/**
 * Starts the inbound SMTP listener.
 * acceptRecipient(address) -> bool: whether we handle mail for this address.
 * onMessage(parsed, envelope) -> Promise: called for every accepted message.
 */
async function startListener({ mail, listener, acceptRecipient, onMessage, log }) {
  const allowed = await allowedSourceIps(mail, listener);
  const server = new SMTPServer({
    name: undefined,
    banner: 'ready',
    authOptional: true,
    disabledCommands: ['AUTH'].concat(listener.offerStartTls ? [] : ['STARTTLS']),
    size: 25 * 1024 * 1024,
    logger: false,
    onConnect(session, cb) {
      const ip = normIp(session.remoteAddress);
      if (!allowed.has(ip)) {
        log('error', `Rejected inbound SMTP connection from ${ip}. Only ${[...allowed].join(', ')} may connect (add it under Settings → Reply listener if it is the mail server).`);
        return cb(smtpError(554, `5.7.1 Access denied: ${ip} is not an allowed mail server for this listener`));
      }
      cb();
    },
    onRcptTo(address, _session, cb) {
      if (!acceptRecipient(address.address)) return cb(smtpError(550, 'No such user here'));
      cb();
    },
    onData(stream, session, cb) {
      let answered = false;
      // Copy the envelope now: the session resets it once the message is acknowledged.
      const envelope = {
        from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
        to: session.envelope.rcptTo.map((r) => r.address),
      };
      simpleParser(stream)
        .then((parsed) => {
          if (stream.sizeExceeded) throw smtpError(552, 'Message too large');
          answered = true;
          cb();
          return onMessage(parsed, envelope);
        })
        .catch((e) => {
          if (!answered) return cb(e.responseCode ? e : smtpError(451, 'Temporary processing error'));
          log('error', 'Inbound message failed: ' + e.message);
        });
    },
  });
  server.on('error', (e) => log('error', 'Listener: ' + e.message));
  await new Promise((resolve, reject) => {
    const onErr = (e) => {
      if (e.code === 'EACCES') {
        return reject(new Error(
          `No permission to listen on port ${listener.port}. Linux reserves ports below 1024 for root. ` +
          `Allow it once with: sudo sysctl -w net.ipv4.ip_unprivileged_port_start=${listener.port} ` +
          '(see README to make it permanent).'
        ));
      }
      if (e.code === 'EADDRINUSE') {
        return reject(new Error(`Port ${listener.port} is already in use by another service on this machine (e.g. a local Postfix/Exim). Stop it or use another port.`));
      }
      reject(e);
    };
    server.server.once('error', onErr);
    server.listen(Number(listener.port), listener.bindAddress || '0.0.0.0', () => {
      server.server.off('error', onErr);
      resolve();
    });
  });
  return { server, allowed: [...allowed] };
}

module.exports = { serverHost, sendMail, verifySmtp, startListener, allowedSourceIps };
