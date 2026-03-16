/**
 * Host File Access — approval-based file access for container agents.
 *
 * When an agent requests a host file, the user is asked to approve.
 * Approved directories are cached so subsequent requests under the
 * same root don't require re-approval.
 *
 * Approval cache is persisted to data/file-access-approvals.json
 * and survives restarts.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface ApprovedDir {
  path: string;
  readOnly: boolean;
  approvedAt: string;
  approvedBy: string; // chatJid that approved
}

interface PendingApproval {
  requestId: string;
  filePath: string;
  reason: string;
  type: 'file_request' | 'file_write_request' | 'dir_list_request';
  content?: string; // for write requests
  groupFolder: string;
  chatJid: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── State ────────────────────────────────────────────────────────────────────

const APPROVALS_FILE = path.join(DATA_DIR, 'file-access-approvals.json');
let approvedDirs: ApprovedDir[] = [];
const pendingApprovals = new Map<string, PendingApproval>();

// ── Persistence ──────────────────────────────────────────────────────────────

function loadApprovals(): void {
  try {
    if (fs.existsSync(APPROVALS_FILE)) {
      approvedDirs = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf-8'));
    }
  } catch {
    approvedDirs = [];
  }
}

function saveApprovals(): void {
  fs.mkdirSync(path.dirname(APPROVALS_FILE), { recursive: true });
  fs.writeFileSync(APPROVALS_FILE, JSON.stringify(approvedDirs, null, 2));
}

// Load on module init
loadApprovals();

// ── Approval check ───────────────────────────────────────────────────────────

/**
 * Check if a path is under an already-approved directory.
 * For write requests, the approval must not be readOnly.
 */
export function isPathApproved(filePath: string, needsWrite: boolean): boolean {
  const resolved = path.resolve(filePath);
  for (const dir of approvedDirs) {
    const dirResolved = path.resolve(dir.path);
    const rel = path.relative(dirResolved, resolved);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      if (needsWrite && dir.readOnly) continue;
      return true;
    }
  }
  return false;
}

/**
 * Add a directory to the approved list.
 */
export function approveDirectory(
  dirPath: string,
  readOnly: boolean,
  chatJid: string,
): void {
  const resolved = path.resolve(dirPath);
  // Don't duplicate
  if (approvedDirs.some((d) => path.resolve(d.path) === resolved)) return;
  approvedDirs.push({
    path: resolved,
    readOnly,
    approvedAt: new Date().toISOString(),
    approvedBy: chatJid,
  });
  saveApprovals();
  logger.info(
    { path: resolved, readOnly },
    'Directory approved for file access',
  );
}

/**
 * Get all approved directories (for display).
 */
export function getApprovedDirs(): ApprovedDir[] {
  return [...approvedDirs];
}

/**
 * Clear all approvals.
 */
export function clearApprovals(): void {
  approvedDirs = [];
  saveApprovals();
}

// ── Pending approval management ──────────────────────────────────────────────

const APPROVAL_TIMEOUT_MS = 120_000; // 2 minutes

export interface FileAccessRequest {
  requestId: string;
  filePath: string;
  reason: string;
  type: 'file_request' | 'file_write_request' | 'dir_list_request';
  content?: string;
  groupFolder: string;
  chatJid: string;
}

/**
 * Register a pending approval. Returns a promise that resolves when
 * the user approves or denies (or times out).
 */
export function requestApproval(req: FileAccessRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(req.requestId);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(req.requestId, {
      ...req,
      resolve,
      timer,
    });
  });
}

/**
 * Resolve a pending approval (called when user replies).
 */
export function resolveApproval(requestId: string, approved: boolean): boolean {
  const pending = pendingApprovals.get(requestId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingApprovals.delete(requestId);
  pending.resolve(approved);
  return true;
}

/**
 * Try to resolve approval by matching user reply text.
 * Returns true if a pending approval was found and resolved.
 */
export function tryResolveApprovalFromReply(
  chatJid: string,
  text: string,
): boolean {
  const normalized = text.trim().toLowerCase();
  const isApprove =
    normalized === 'y' ||
    normalized === 'yes' ||
    normalized === '是' ||
    normalized === '允许' ||
    normalized === '同意' ||
    normalized === '好' ||
    normalized === '可以' ||
    normalized === 'ok';
  const isDeny =
    normalized === 'n' ||
    normalized === 'no' ||
    normalized === '否' ||
    normalized === '拒绝' ||
    normalized === '不' ||
    normalized === '不行';

  if (!isApprove && !isDeny) return false;

  // Find the most recent pending approval for this chatJid
  for (const [id, pending] of pendingApprovals) {
    if (pending.chatJid === chatJid) {
      resolveApproval(id, isApprove);
      return true;
    }
  }
  return false;
}

/**
 * Check if there are pending approvals for a given chatJid.
 */
export function hasPendingApproval(chatJid: string): boolean {
  for (const pending of pendingApprovals.values()) {
    if (pending.chatJid === chatJid) return true;
  }
  return false;
}
