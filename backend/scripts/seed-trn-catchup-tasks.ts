/**
 * seed-trn-catchup-tasks.ts — create Jake's TRN catch-up list as real
 * structured tasks in the SyteLine task-agent queue.
 *
 * Usage (from backend/):
 *   npx tsx scripts/seed-trn-catchup-tasks.ts --email jsmith1@enflite.com
 *   npx tsx scripts/seed-trn-catchup-tasks.ts --email jsmith1@enflite.com --dry-run
 *   npx tsx scripts/seed-trn-catchup-tasks.ts --email jsmith1@enflite.com --force
 *
 * What it does:
 * - Resolves the requester by email (user -> membership -> tenant/role) and
 *   builds a live AuthContext exactly like login does (buildAuth).
 * - Creates one task per TRN catch-up step with the ordered goal text.
 * - Tasks blocked on external open items / team sign-off are parked as
 *   `blocked` with a machine-readable reason so the runner never claims
 *   them; re-queue later with `syteline.task.requeue` (board or chat)
 *   once the dependency clears.
 * - Write steps are NOT pre-approved: tasks are created with
 *   autoApproveWrites=false (the default). The runner does read-only
 *   reconnaissance, records the proposed write plan, and parks the task
 *   as blocked/awaiting-write-approval; approve from the board or with
 *   `syteline.task.requeue` + approveWrites=true.
 *
 * Idempotency: every goal carries the marker [trn-catchup-2026-10-02].
 * Re-running without --force exits early when marker tasks already exist.
 *
 * VALIDATED IN CI: script compiles (typecheck). Real MongoDB + real user
 * REQUIRES PRODUCTION INFRASTRUCTURE (Jake's backend env).
 */

import { getDb, closeDb } from '../src/db/mongo.js';
import { buildAuth, type MembershipRow } from '../src/auth/routes.js';
import { createTask } from '../src/syteline/tasks/taskStore.js';
import type { SytelineTaskDoc } from '../src/syteline/tasks/taskTypes.js';
import type { AuthContext } from '../src/authz/permissions.js';
import type { Classification } from '../src/authz/permissions.js';

const MARKER = '[trn-catchup-2026-10-02]';

interface TaskDef {
  title: string;
  goal: string;
  /** Park as blocked immediately (external dependency / human gate). */
  blockedReason?: string;
}

const TASKS: TaskDef[] = [
  {
    title: 'TRN Step 4 — eTRRs IDO properties update',
    goal:
      `${MARKER} TRN catch-up (SyteLine test tenant, still on the 09-28 build).\n` +
      `Step 4 — IDO properties update for the eTRRs form: in the form designer, ` +
      `set the \`status\` property Length to 40; delete the IDO properties from ` +
      `Sequence 8 onward; then paste/import the latest ue_etrrs_ido_properties_import.csv. ` +
      `Verify the property list matches the CSV afterward. ` +
      `Writes — requires approval before executing.`,
  },
  {
    title: 'TRN Step 5 — TrrNum AUTONUMBER check',
    goal:
      `${MARKER} TRN catch-up (SyteLine test tenant, still on the 09-28 build).\n` +
      `Step 5 — verify that TrrNum has AUTONUMBER(STEP(1)) on the eTRRs IDO/form in TRN. ` +
      `Read-only check; report the current setting and whether it matches.`,
  },
  {
    title: 'TRN Step 6a — Inline lists for Reason and Cause',
    goal:
      `${MARKER} TRN catch-up (SyteLine test tenant, still on the 09-28 build).\n` +
      `Step 6 (part 1) — set the Inline Lists for the Reason and Cause fields on the eTRRs ` +
      `form in TRN (both value lists are ready). Do NOT touch the Status and Priority ` +
      `inline lists — those wait on open items 2 and 3 (separate task). ` +
      `Writes — requires approval before executing.`,
  },
  {
    title: 'TRN Step 6b — Inline lists for Status and Priority',
    goal:
      `${MARKER} TRN catch-up (SyteLine test tenant, still on the 09-28 build).\n` +
      `Step 6 (part 2) — set the Inline Lists for the Status and Priority fields on the eTRRs ` +
      `form in TRN. BLOCKED: waiting on open items 2 and 3 (value lists not ready). ` +
      `Do not execute until those are resolved.`,
    blockedReason: 'waiting-on-open-items-2-3',
  },
  {
    title: 'TRN Step 7 — Check in + unload IDO metadata',
    goal:
      `${MARKER} TRN catch-up (SyteLine test tenant, still on the 09-28 build).\n` +
      `Step 7 — check in the eTRRs form changes in TRN, then Unload IDO Metadata, ` +
      `then sign out and back in to SyteLine and confirm the session picks up the changes. ` +
      `Writes — requires approval before executing.`,
  },
  {
    title: 'TRN Step 8 — Team access',
    goal:
      `${MARKER} TRN catch-up (SyteLine test tenant, still on the 09-28 build).\n` +
      `Step 8 — give the team access to the eTRRs form/IDO in TRN. ` +
      `BLOCKED: needs open item 10 resolved first. Do not execute until then.`,
    blockedReason: 'waiting-on-open-item-10',
  },
  {
    title: 'TRN Step 9 — Re-import eTRRs form XML',
    goal:
      `${MARKER} TRN catch-up (SyteLine test tenant, still on the 09-28 build).\n` +
      `Step 9 (repeat) — re-import the current exports/eTRRs_v1.XML into TRN via the form ` +
      `import. NOTE: the runner's plan DSL currently has no file-upload step, so the ` +
      `planner may be unable to express the file selection — if the plan cannot include ` +
      `the upload, park the task and report; the import may need a manual assist or the ` +
      `upload-step follow-up. Writes — requires approval before executing.`,
  },
  {
    title: 'TRN Steps 10–12 — IDO checks, first TRR, copy from vendor',
    goal:
      `${MARKER} TRN catch-up (SyteLine test tenant, still on the 09-28 build).\n` +
      `Steps 10–12 — run the IDO checks on the eTRRs form in TRN, then create a first ` +
      `TRR with no topic, then exercise Copy TRRs from the vendor form. ` +
      `Report the result of each step. Writes — requires approval before executing.`,
  },
  {
    title: 'TRN Section 6 — Test checklist + team sign-off',
    goal:
      `${MARKER} TRN catch-up (SyteLine test tenant, still on the 09-28 build).\n` +
      `Section 6 — run the eTRRs test checklist in TRN and collect the team's sign-off. ` +
      `BLOCKED: requires human sign-off. The agent may execute the checklist items, but ` +
      `a person must give the sign-off — never mark this complete without explicit ` +
      `human confirmation.`,
    blockedReason: 'waiting-on-team-signoff',
  },
];

function usage(): never {
  console.error(
    'Usage: npx tsx scripts/seed-trn-catchup-tasks.ts --email <requester email> [--dry-run] [--force]',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const emailArg = args.find((a) => a.startsWith('--email='));
  const emailFlagIdx = args.indexOf('--email');
  const email =
    emailArg?.slice('--email='.length) ??
    (emailFlagIdx >= 0 ? args[emailFlagIdx + 1] : undefined);
  if (!email || email.startsWith('--')) usage();
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  const db = await getDb();

  const user = await db
    .collection<{
      _id: string;
      email: string;
      passwordHash: string;
      displayName: string;
      isActive: boolean;
      clearance: Classification;
    }>('users')
    .findOne({ email: email!.toLowerCase() });
  if (!user || user.isActive === false) {
    throw new Error(`No active user found for email ${email}`);
  }
  const membership = await db
    .collection<{ _id: string; userId: string; tenantId: string; roleId: string }>(
      'memberships',
    )
    .findOne({ userId: user._id });
  if (!membership) throw new Error(`User ${email} has no tenant membership`);
  const [tenant, role] = await Promise.all([
    db.collection<{ _id: string; name: string }>('tenants').findOne({ _id: membership.tenantId }),
    db.collection<{ _id: string; name: string }>('roles').findOne({ _id: membership.roleId }),
  ]);
  if (!tenant || !role) throw new Error('Tenant or role not found for membership');

  const membershipRow: MembershipRow = {
    tenantId: membership.tenantId,
    tenantName: tenant.name,
    roleId: membership.roleId,
    roleName: role.name,
  };
  const baseAuth = await buildAuth(
    {
      id: user._id,
      email: user.email,
      passwordHash: user.passwordHash,
      displayName: user.displayName,
      isActive: user.isActive,
      clearance: user.clearance,
    },
    membershipRow,
  );
  const auth: AuthContext = { ...baseAuth, sessionId: `seed:${Date.now()}` };

  if (!auth.permissions.includes('syteline:ui')) {
    throw new Error(
      `User ${email} does not hold syteline:ui — run the all-permissions migration first (npm run migrate)`,
    );
  }

  const existing = await db
    .collection('syteline_tasks')
    .countDocuments({ tenantId: auth.tenantId, goal: { $regex: MARKER.replace(/[[\]]/g, '\\$&') } });
  if (existing > 0 && !force) {
    console.log(
      `Found ${existing} existing task(s) with marker ${MARKER} — nothing to do. ` +
        `Re-run with --force to create duplicates.`,
    );
    return;
  }

  console.log(
    `Creating ${TASKS.length} TRN catch-up tasks as ${auth.email} (tenant ${auth.tenantId})` +
      (dryRun ? ' [dry run]' : ''),
  );
  for (const def of TASKS) {
    if (dryRun) {
      console.log(`  - ${def.title}${def.blockedReason ? ` [blocked: ${def.blockedReason}]` : ''}`);
      continue;
    }
    const task = await createTask(
      auth,
      { title: def.title, goal: def.goal, autoApproveWrites: false },
      auth.clearance,
    );
    if (def.blockedReason) {
      await db.collection<SytelineTaskDoc>('syteline_tasks').updateOne(
        { _id: task._id, tenantId: auth.tenantId },
        {
          $set: {
            status: 'blocked',
            blockedReason: def.blockedReason,
            completedAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );
    }
    console.log(
      `  created ${task._id} — ${def.title}` +
        (def.blockedReason ? ` [blocked: ${def.blockedReason}]` : ' [assigned]'),
    );
  }
  console.log(
    dryRun
      ? 'Dry run complete — no tasks created.'
      : 'Done. Review on the board; approve write plans with syteline.task.requeue.',
  );
}

main()
  .catch((err) => {
    console.error(`seed-trn-catchup-tasks failed: ${(err as Error).message}`);
    process.exit(1);
  })
  .finally(() => closeDb());
