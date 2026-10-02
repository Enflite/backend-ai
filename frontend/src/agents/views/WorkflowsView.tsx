/**
 * agents/views/WorkflowsView.tsx — reusable task templates (`/agents/workflows`).
 *
 * Structure only: a workflow captures a finished task's goal, plan shape,
 * required inputs, approval requirements, and verification rules so it can
 * be re-run later. No workflow functionality exists on the backend yet, so
 * this view is an honest empty state describing what's coming — never fake
 * entries.
 */
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/ui/primitives';

export default function WorkflowsView() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <PageHeader
          title="Workflows"
          description="Reusable templates distilled from tasks the agent has completed — run the same operational procedure again with new inputs."
        />
        <div
          className="mt-6 rounded-lg p-8 text-center"
          style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
        >
          <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            No workflows yet
          </h2>
          <p className="text-sm mt-1 max-w-md mx-auto" style={{ color: 'var(--muted-foreground)' }}>
            Workflows are built from completed tasks: the goal, the verified plan, the approval
            points, and the checks that proved it worked. Finish a task first — repeatable ones
            like “TRN catch-up” or “help publication” will become one-click workflows here.
          </p>
          <Link
            to="/agents/tasks"
            className="inline-block mt-4 text-sm font-medium px-4 py-2 rounded-md"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            Go to tasks
          </Link>
        </div>
        <div className="mt-6 text-sm" style={{ color: 'var(--muted-foreground)' }}>
          <h3 className="text-xs font-semibold uppercase tracking-wide">What a workflow will carry</h3>
          <ul className="mt-2 space-y-1 text-sm list-disc list-inside">
            <li>Goal and required inputs (environment, form, report, …)</li>
            <li>The verified step plan, with read-only checks first</li>
            <li>Which steps need human approval before they run</li>
            <li>The verification rules that prove the run worked</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
