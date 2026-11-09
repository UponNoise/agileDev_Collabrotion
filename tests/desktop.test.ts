import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopClipboardAllowed, desktopCommitLink, isWorkspaceUrl } from '../src/desktop-policy.js';

const endpoint = 'http://127.0.0.1:43170';
const issueUrl = `${endpoint}/?issue=fixture#evidence`;
const commitUrl = `https://github.com/uponnoise/agiledev_collabrotion/commit/${'a'.repeat(40)}`;
const mainFrame = { workspaceContents: true, isMainFrame: true, contentsUrl: issueUrl, requestingUrl: issueUrl };

test('desktop credential copy grants only sanitized writes from the workspace main frame', () => {
  assert.equal(desktopClipboardAllowed(endpoint, 'clipboard-sanitized-write', mainFrame), true);
  assert.equal(desktopClipboardAllowed(endpoint, 'clipboard-sanitized-write', { ...mainFrame, requestingOrigin: endpoint }), true);
  for (const permission of ['clipboard-read', 'clipboard-write', 'media', 'notifications', 'openExternal', 'unknown']) {
    assert.equal(desktopClipboardAllowed(endpoint, permission, mainFrame), false, permission);
  }
  for (const request of [
    { ...mainFrame, workspaceContents: false },
    { ...mainFrame, isMainFrame: false },
    { ...mainFrame, requestingUrl: undefined },
    { ...mainFrame, requestingOrigin: '' },
    { ...mainFrame, requestingOrigin: 'https://example.com' }
  ]) assert.equal(desktopClipboardAllowed(endpoint, 'clipboard-sanitized-write', request), false);
});

test('desktop permissions and navigation reject foreign, credentialed and opaque URLs', () => {
  assert.equal(isWorkspaceUrl(endpoint, issueUrl), true);
  for (const url of [
    undefined, '', 'not a URL', 'https://example.com', 'http://127.0.0.1:43171/',
    'http://localhost:43170/', 'http://user:secret@127.0.0.1:43170/',
    `blob:${endpoint}/fixture`, 'data:text/html,fixture', 'file:///fixture', 'javascript:void(0)'
  ]) {
    assert.equal(isWorkspaceUrl(endpoint, url), false, String(url));
    assert.equal(desktopClipboardAllowed(endpoint, 'clipboard-sanitized-write', { ...mainFrame, contentsUrl: url }), false);
    assert.equal(desktopClipboardAllowed(endpoint, 'clipboard-sanitized-write', { ...mainFrame, requestingUrl: url }), false);
    assert.equal(desktopCommitLink(endpoint, url, commitUrl), undefined);
  }
  assert.equal(isWorkspaceUrl('https://example.com', 'https://example.com'), false);
});

test('desktop opens only canonical full-SHA GitHub commit evidence in the browser', () => {
  assert.equal(desktopCommitLink(endpoint, issueUrl, commitUrl), commitUrl);
  for (const target of [
    `${endpoint}/?issue=other`, 'https://github.com', 'https://example.com',
    commitUrl.replace('https:', 'http:'), commitUrl.replace('github.com', 'github.com.evil.test'),
    commitUrl.replace('github.com', 'user:secret@github.com'), commitUrl.replace('github.com', 'github.com:443'),
    commitUrl.replace('github.com', 'GITHUB.COM'), commitUrl.replace('/commit/', '/tree/'),
    commitUrl.replace('/uponnoise/', '/%75ponnoise/'), commitUrl.replace('/agiledev_collabrotion/', '/../'),
    commitUrl.replace('/agiledev_collabrotion/', '/./'), commitUrl.slice(0, -1), `${commitUrl}a`,
    `${commitUrl}?redirect=https://example.com`, `${commitUrl}#diff`, `${commitUrl}/`, `${commitUrl}\n`,
    ` ${commitUrl}`, 'file:///fixture', 'javascript:alert(1)', 'https://github.com\\@evil.test'
  ]) assert.equal(desktopCommitLink(endpoint, issueUrl, target), undefined, target);
});
