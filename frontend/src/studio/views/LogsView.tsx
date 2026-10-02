/**
 * studio/views/LogsView.tsx — studio audit logs.
 *
 * There is no studio-scoped log endpoint in the contract yet, and the
 * frontend has no audit-log UI client to bind to — so this is the honest
 * empty state, not a placeholder wired to a guessed endpoint.
 */
import StudioEmpty, { IconList, StudioEmptyIcon } from '../components/StudioEmpty';

export default function LogsView() {
  return (
    <StudioEmpty
      icon={
        <StudioEmptyIcon>
          <IconList />
        </StudioEmptyIcon>
      }
      title="No logs yet"
      description="Studio activity — connection changes, automation runs, and action executions — will be recorded here with a full audit trail once the backend's log endpoint lands."
    />
  );
}
