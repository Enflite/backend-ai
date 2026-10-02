/**
 * studio/views/RunsView.tsx — run history for studio automations.
 *
 * Run recording lands with the backend builder slice; there is no runs
 * endpoint in the studio contract yet, so this renders the honest empty
 * state rather than inventing run history.
 */
import StudioEmpty, { IconList, StudioEmptyIcon } from '../components/StudioEmpty';

export default function RunsView() {
  return (
    <StudioEmpty
      icon={
        <StudioEmptyIcon>
          <IconList />
        </StudioEmptyIcon>
      }
      title="No runs yet"
      description="Every automation run — what ran, which actions fired, what changed, and the evidence — will show up here with a full audit trail. Runs appear once your first automation executes."
    />
  );
}
