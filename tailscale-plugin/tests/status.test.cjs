'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStatusJson, parsePingOutput, extractAuthUrlFromText } = require('../core/status.cjs');

test('parseStatusJson parses connected state, TUN flag, self IP, and sorts peers by Direct/DERP/Offline', () => {
  const sample = {
    Version: '1.104.7',
    TUN: true,
    BackendState: 'Running',
    TailscaleIPs: ['100.64.0.10', 'fd7a:115c:a1e0::10'],
    CurrentTailnet: { Name: 'user@example.com', MagicDNSSuffix: 'tail1234.ts.net' },
    Self: {
      HostName: 'office-pc',
      DNSName: 'office-pc.tail1234.ts.net.',
      OS: 'windows',
      Online: true,
      TailscaleIPs: ['100.64.0.10'],
    },
    Peer: {
      'nodekey:1': {
        ID: 'id1',
        HostName: 'iphone-shadowrocket',
        DNSName: 'iphone.tail1234.ts.net.',
        OS: 'iOS',
        TailscaleIPs: ['100.64.0.30'],
        Online: true,
        Relay: 'hkg',
        CurAddr: '',
      },
      'nodekey:2': {
        ID: 'id2',
        HostName: 'nas-offline',
        DNSName: 'nas.tail1234.ts.net.',
        OS: 'linux',
        TailscaleIPs: ['100.64.0.40'],
        Online: false,
      },
      'nodekey:3': {
        ID: 'id3',
        HostName: 'home-pc',
        DNSName: 'home-pc.tail1234.ts.net.',
        OS: 'windows',
        TailscaleIPs: ['100.64.0.20'],
        Online: true,
        CurAddr: '203.0.113.5:41641',
        Relay: 'sha',
      },
    },
    Health: ['tskey-auth-should-be-redacted'],
  };

  const parsed = parseStatusJson(JSON.stringify(sample));
  assert.equal(parsed.phase, 'connected');
  assert.equal(parsed.tun, true);
  assert.equal(parsed.tunWarning, false);
  assert.equal(parsed.self.ipv4, '100.64.0.10');
  assert.equal(parsed.self.hostName, 'office-pc');
  assert.equal(parsed.tailnetName, 'user@example.com');
  assert.deepEqual(parsed.summary, {
    totalPeers: 3,
    onlinePeers: 2,
    directPeers: 1,
    derpPeers: 1,
  });
  assert.deepEqual(parsed.peers.map((p) => p.hostName), ['home-pc', 'iphone-shadowrocket', 'nas-offline']);
  assert.equal(parsed.peers[0].connectionType, 'direct');
  assert.equal(parsed.peers[1].connectionType, 'derp');
  assert.equal(parsed.peers[2].connectionType, 'offline');
  assert.equal(parsed.health[0].includes('should-be-redacted'), false);
});

test('parseStatusJson flags tunWarning when Running with TUN=false and handles NeedsLogin', () => {
  const loginState = parseStatusJson({
    BackendState: 'NeedsLogin',
    TUN: true,
    AuthURL: 'https://login.tailscale.com/a/abc999',
  });
  assert.equal(loginState.phase, 'needs_login');
  assert.equal(loginState.authUrl, 'https://login.tailscale.com/a/abc999');

  const noTun = parseStatusJson({ BackendState: 'Running', TUN: false });
  assert.equal(noTun.phase, 'connected');
  assert.equal(noTun.tunWarning, true);
});

test('parsePingOutput distinguishes direct and DERP replies', () => {
  const direct = parsePingOutput('pong from home-pc (100.64.0.20) via 203.0.113.5:41641 in 12.4ms');
  assert.equal(direct.ok, true);
  assert.equal(direct.mode, 'direct');
  assert.equal(direct.latencyMs, 12.4);

  const derp = parsePingOutput('pong from iphone (100.64.0.30) via DERP(hkg) in 48ms');
  assert.equal(derp.ok, true);
  assert.equal(derp.mode, 'derp');
  assert.equal(derp.via, 'DERP(hkg)');
});

test('extractAuthUrlFromText pulls clean login URL', () => {
  const url = extractAuthUrlFromText('To authenticate, visit:\n\thttps://login.tailscale.com/a/12345abc.\n');
  assert.equal(url, 'https://login.tailscale.com/a/12345abc');
});
