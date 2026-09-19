/*
  Role hierarchy:
    super_admin > admin > analyst > viewer

  super_admin / admin  — full access
  analyst              — view all; operate pipelines (start/pause/run); manage DLQ; no create/edit/delete of connections or pipelines
  viewer               — read-only on dashboard, jobs, log-history; no connections, no pipeline controls
*/

export const ROLE_WEIGHT = { super_admin: 4, admin: 3, analyst: 2, viewer: 1 };

function role() {
  return localStorage.getItem('lb_role') || 'viewer';
}
function w() { return ROLE_WEIGHT[role()] ?? 1; }

export const can = {
  // Navigation visibility
  seeConnections:  () => w() >= 2,   // analyst+
  seePipelines:    () => w() >= 1,   // all
  seeJobs:         () => w() >= 1,   // all
  seeLogHistory:   () => w() >= 1,   // all
  seeDashboard:    () => w() >= 1,   // all
  seeSettings:     () => true,       // all (My Profile tab always visible)

  // Pipeline actions
  createPipeline:  () => w() >= 3,   // admin+
  editPipeline:    () => w() >= 3,   // admin+
  deletePipeline:  () => w() >= 3,   // admin+
  operatePipeline: () => w() >= 2,   // analyst+ (start/pause/run-now/reset-cursor)
  resetStats:      () => w() >= 3,   // admin+

  // Connection / Cluster actions
  createConnection: () => w() >= 3,  // admin+
  editConnection:   () => w() >= 3,
  deleteConnection: () => w() >= 3,

  // Job / DLQ actions
  manageDlq:       () => w() >= 2,   // analyst+

  // Settings
  seeAdminSettings: () => w() >= 3,  // admin+
};

export function useRole() {
  const r = role();
  return { role: r, can, isAdmin: w() >= 3, isSuperAdmin: r === 'super_admin' };
}
