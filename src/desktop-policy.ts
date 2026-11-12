export function isWorkspaceUrl(endpoint: string, value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && url.origin === endpoint;
  } catch { return false; }
}

export function desktopClipboardAllowed(endpoint: string, permission: string, request: {
  workspaceContents: boolean;
  isMainFrame: boolean;
  contentsUrl?: string;
  requestingUrl?: string;
  requestingOrigin?: string;
}) {
  return permission === 'clipboard-sanitized-write' && request.workspaceContents && request.isMainFrame &&
    isWorkspaceUrl(endpoint, request.contentsUrl) && isWorkspaceUrl(endpoint, request.requestingUrl) &&
    (request.requestingOrigin === undefined || isWorkspaceUrl(endpoint, request.requestingOrigin));
}

export function desktopAttentionAllowed(endpoint: string, request: {
  workspaceContents: boolean;
  isMainFrame: boolean;
  contentsUrl?: string;
  requestingUrl?: string;
}) {
  return request.workspaceContents && request.isMainFrame && isWorkspaceUrl(endpoint, request.contentsUrl) && isWorkspaceUrl(endpoint, request.requestingUrl);
}

export function desktopCommitLink(endpoint: string, contentsUrl: string | undefined, target: string) {
  if (!isWorkspaceUrl(endpoint, contentsUrl)) return undefined;
  const match = target.match(/^https:\/\/github\.com\/([a-z0-9][a-z0-9-]*)\/([a-z0-9_.-]+)\/commit\/([a-f0-9]{40})$/);
  return match?.[0] === target && !['.', '..'].includes(match[2]!) ? target : undefined;
}
